import { randomUUID } from "node:crypto";
import { createSocket, type Socket as Datagram } from "node:dgram";
import { createServer, type Server, type Socket } from "node:net";
import { WebSocket } from "ws";
import { type BindMessage, pack, unpack } from "../runtime/bind-wire.ts";
import type { Grant } from "../runtime/types.ts";

export function bindConnection(ws: WebSocket, binding: Grant, outgoing: Grant[]) {
	let listener: Server | undefined,
		udp: Datagram | undefined,
		main = "",
		closed = false;
	const peers = new Map<string, Socket>(),
		senders = new Set<string>();
	function send(m: BindMessage) {
		if (ws.readyState !== WebSocket.OPEN) return;
		if (ws.bufferedAmount > 8 * 1024 * 1024) {
			ws.terminate();
			return;
		}
		ws.send(pack(m));
	}
	const ack = (m: BindMessage, err?: Error | null) =>
		send({ type: err ? "error" : "ack", id: m.id, seq: m.seq, message: err?.message });
	function done() {
		if (closed && !peers.size) ws.close();
	}
	function shutdown() {
		closed = true;
		listener?.close();
		if (udp) {
			try {
				udp.close();
			} catch {
				/* A failed bind never opened. */
			}
			udp = undefined;
		}
	}
	ws.once("close", () => {
		shutdown();
		for (const p of peers.values()) p.destroy();
	});
	ws.on("error", () => ws.terminate());
	ws.on("message", (raw, isBinary) => {
		try {
			if (!isBinary || !Buffer.isBuffer(raw)) throw Error("Expected binding packet");
			const m = unpack(raw);
			if (!main) {
				if (m.type !== (binding.protocol === "tcp" ? "listen" : "udp") || !m.id)
					throw Error("Invalid binding operation");
				main = m.id;
				const failed = (e: Error) => {
					send({ type: "error", id: main, message: e.message });
					ws.close();
				};
				if (binding.protocol === "tcp") {
					listener = createServer((socket) => {
						if (peers.size >= 64) {
							socket.destroy();
							return;
						}
						const id = randomUUID();
						peers.set(id, socket);
						send({
							type: "accept",
							id: main,
							socket: id,
							info: {
								localAddress: socket.localAddress,
								localPort: socket.localPort,
								remoteAddress: socket.remoteAddress,
								remotePort: socket.remotePort,
							},
						});
						socket.on("data", (data: Buffer) => send({ type: "data", id, data }));
						socket.on("error", (e) => send({ type: "error", id, message: e.message }));
						socket.once("close", () => {
							peers.delete(id);
							send({ type: "close", id });
							done();
						});
					});
					listener.once("error", failed);
					listener.listen(binding.port, binding.address, () => {
						const a = listener?.address();
						if (a && typeof a !== "string")
							send({
								type: "open",
								id: main,
								info: { localAddress: a.address, localPort: a.port },
							});
					});
				} else {
					udp = createSocket(binding.address === "::1" ? "udp6" : "udp4");
					udp.once("error", failed);
					udp.on("message", (data, r) => {
						if (senders.size >= 256) senders.delete(senders.values().next().value || "");
						senders.add(`${r.address}:${r.port}`);
						send({ type: "data", id: main, data, host: r.address, port: r.port });
					});
					udp.bind(binding.port, binding.address, () => {
						const a = udp?.address();
						if (a)
							send({
								type: "open",
								id: main,
								info: { localAddress: a.address, localPort: a.port },
							});
					});
				}
				return;
			}
			if (m.type === "close") {
				if (m.id === main) {
					shutdown();
					done();
				} else peers.get(m.id)?.end();
				return;
			}
			if (m.type !== "data" || !m.data) {
				ack(m, Error("Unsupported operation for physical loopback binding"));
				return;
			}
			if (m.id === main && udp) {
				const { host, port } = m;
				if (
					!host ||
					!port ||
					!(
						senders.has(`${host}:${port}`) ||
						outgoing.some((g) => g.protocol === "udp" && g.address === host && g.port === port)
					)
				) {
					ack(m, Error("UDP destination is not a sender or a granted endpoint"));
					return;
				}
				udp.send(m.data, port, host, (e) => ack(m, e));
				return;
			}
			const peer = peers.get(m.id);
			if (!peer || peer.destroyed) {
				ack(m, Error("Peer closed"));
				return;
			}
			peer.write(m.data, (e) => ack(m, e));
		} catch {
			ws.close(1008, "Invalid binding request");
		}
	});
}
