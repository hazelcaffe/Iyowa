import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { logging, packet, server as wisp } from "@mercuryworkshop/wisp-js/server";
import ipaddr from "ipaddr.js";
import { type WebSocket, WebSocketServer } from "ws";

export const HOST_BLOCKED = 0x48;

/** Destination check, performed on the address the relay actually connects to. */
export type Decide = (ip: string, port: number, type: "tcp" | "udp") => boolean;

export function isPublicAddress(ip: string): boolean {
	try {
		return ipaddr.process(ip).range() === "unicast";
	} catch {
		return false;
	}
}

interface SocketLike {
	hostname: string;
	port: number;
	connect(ip?: string | null): Promise<void>;
}
type SocketClass = new (hostname: string, port: number) => SocketLike;

/**
 * wisp-js resolves names itself and then calls connect(ip). Gate that call, so DNS answers
 * cannot redirect a public name to a private address after the check (no rebinding window).
 * With `ack`, a successful TCP connect is reported with an early CONTINUE packet: Direct
 * Sockets' `opened` must only resolve once the remote host has accepted the connection.
 */
function policyConnection(ws: WebSocket, path: string, version: number, decide: Decide, ack: boolean) {
	const connection = new wisp.ServerConnection(ws, path, { wisp_version: version });
	let creating = 0;
	const createStream = connection.create_stream.bind(connection);
	connection.create_stream = (id: number, type: number, host: string, port: number) => {
		creating = id;
		createStream(id, type, host, port);
	};
	const wrap = (Base: SocketClass, type: "tcp" | "udp"): SocketClass =>
		class PolicySocket extends Base {
			readonly streamId = creating;
			override async connect(ip?: string | null): Promise<void> {
				if (!ip || !decide(ip, this.port, type)) {
					await connection.close_stream(this.streamId, HOST_BLOCKED);
					throw Error(`Blocked ${type} destination ${this.hostname}:${this.port}`);
				}
				await super.connect(ip);
				if (ack && type === "tcp")
					await connection.ws.send(
						new packet.WispPacket({
							type: packet.ContinuePayload.type,
							stream_id: this.streamId,
							payload: new packet.ContinuePayload({
								buffer_remaining: wisp.options.send_buffer_size,
							}),
						}),
					);
			}
		};
	connection.TCPSocket = wrap(connection.TCPSocket as SocketClass, "tcp");
	connection.UDPSocket = wrap(connection.UDPSocket as SocketClass, "udp");
	return connection;
}

export interface RelayRoute {
	/** Accept the WebSocket, or return undefined to reject the upgrade. */
	accept(request: IncomingMessage): { decide: Decide; ack: boolean } | undefined;
}

export function createRelay() {
	logging.set_level(logging.ERROR);
	// Every stream passes the route's own decide() at connect time; wisp-js's global filter must not
	// pre-empt it. Limits bound the work a single page can start.
	Object.assign(wisp.options, {
		allow_loopback_ips: true,
		allow_private_ips: true,
		allow_direct_ip: true,
		stream_limit_total: 256,
		stream_limit_per_host: -1,
	});
	const sockets = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
	return {
		handle(
			request: IncomingMessage,
			socket: Duplex,
			head: Buffer,
			route: { decide: Decide; ack: boolean },
		) {
			if (sockets.clients.size >= 256) {
				socket.destroy();
				return;
			}
			sockets.handleUpgrade(request, socket, head, (ws) => {
				const version = String(request.headers["sec-websocket-protocol"] || "").includes("wisp-v2")
					? 2
					: 1;
				const connection = policyConnection(ws, request.url || "/", version, route.decide, route.ack);
				void connection
					.setup()
					.then(() => connection.run())
					.catch(() => ws.close());
			});
		},
		upgrade(request: IncomingMessage, socket: Duplex, head: Buffer, then: (ws: WebSocket) => void) {
			sockets.handleUpgrade(request, socket, head, then);
		},
		close() {
			for (const ws of sockets.clients) ws.terminate();
			sockets.close();
		},
	};
}
