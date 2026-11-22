import { randomUUID } from "node:crypto";
import { createSocket, type Socket as Datagram } from "node:dgram";
import { lookup } from "node:dns/promises";
import { createServer, isIP, type Server, type Socket } from "node:net";
import { WebSocket } from "ws";
import { type BindMessage, pack, unpack } from "../shared/bind-wire.ts";
import type { Decide } from "./relay.ts";

/**
 * A real OS listener for TCPServerSocket or a bound UDPSocket. The first packet selects the
 * operation; the caller has already checked the app's manifest and local-network permission.
 */
export function bindConnection(ws: WebSocket, decide: Decide) {
	let listener: Server | undefined,
		udp: Datagram | undefined,
		main = "",
		closed = false;
	const peers = new Map<string, Socket>();
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

	function open(m: BindMessage) {
		const host = m.host || "";
		const port = m.port ?? 0;
		if (
			!["listen", "udp"].includes(m.type) ||
			!m.id ||
			!isIP(host) ||
			!Number.isInteger(port) ||
			port < 0 ||
			port > 65535
		)
			throw Error("Invalid binding operation");
		main = m.id;
		const failed = (e: Error) => {
			send({ type: "error", id: main, message: e.message });
			ws.close();
		};
		if (m.type === "listen") {
			listener = createServer((socket) => {
				if (peers.size >= 64) {
					socket.destroy();
					return;
				}
				const id = randomUUID();
				peers.set(id, socket);
				socket.setNoDelay(true);
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
			listener.listen({ port, host, ipv6Only: host === "::1" }, () => {
				const a = listener?.address();
				if (a && typeof a !== "string")
					send({ type: "open", id: main, info: { localAddress: a.address, localPort: a.port } });
			});
			return;
		}
		udp = createSocket({ type: isIP(host) === 6 ? "udp6" : "udp4", reuseAddr: !!m.share });
		udp.once("error", failed);
		udp.on("message", (data, r) => send({ type: "data", id: main, data, host: r.address, port: r.port }));
		udp.bind(port, host, () => {
			const a = udp?.address();
			if (a) send({ type: "open", id: main, info: { localAddress: a.address, localPort: a.port } });
		});
	}

	async function datagram(m: BindMessage & { data: Uint8Array }) {
		const socket = udp;
		if (!socket || !m.host || !m.port) throw Error("Expected a datagram destination");
		const ip = isIP(m.host) ? m.host : (await lookup(m.host)).address;
		if (!decide(ip, m.port, "udp")) throw Error(`Blocked UDP destination ${m.host}:${m.port}`);
		await new Promise<void>((ok, no) => socket.send(m.data, m.port, ip, (e) => (e ? no(e) : ok())));
	}

	ws.on("message", (raw, isBinary) => {
		try {
			if (!isBinary || !Buffer.isBuffer(raw)) throw Error("Expected binding packet");
			const m = unpack(raw);
			if (!main) {
				open(m);
				return;
			}
			if (m.type === "close") {
				if (m.id === main) {
					shutdown();
					done();
				} else peers.get(m.id)?.end();
				return;
			}
			if ((m.type === "join" || m.type === "leave") && m.id === main && udp) {
				try {
					if (!m.host || !isIP(m.host)) throw Error("Expected a multicast group address");
					if (m.type === "join") udp.addMembership(m.host);
					else udp.dropMembership(m.host);
					ack(m);
				} catch (e) {
					ack(m, e as Error);
				}
				return;
			}
			if (m.type !== "data" || !m.data) {
				ack(m, Error("Unsupported operation for a system socket"));
				return;
			}
			if (m.id === main && udp) {
				datagram(m as BindMessage & { data: Uint8Array }).then(
					() => ack(m),
					(e: Error) => ack(m, e),
				);
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
