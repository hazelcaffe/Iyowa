import type { Server } from "node:http";
import { isIP } from "node:net";
import { logging, server as wisp } from "@mercuryworkshop/wisp-js/server";
import { WebSocketServer } from "ws";
import type { Grant } from "../runtime/types.ts";
import { bindConnection } from "./bindings.ts";

export function attachRelay(
	http: Server,
	getGrants: (host: string) => Grant[],
	getBindings: (host: string) => Grant[],
) {
	logging.set_level(logging.ERROR);
	const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
	// All CONNECTs pass the per-app, exact IP + port check before wisp-js can do any DNS or I/O.
	Object.assign(wisp.options, {
		allow_loopback_ips: true,
		allow_private_ips: true,
		stream_limit_total: 32,
	});
	http.on("upgrade", (req, socket, head) => {
		const host = req.headers.host || "",
			grants = getGrants(host);
		const match = /^\/\.iyowa\/bind\/(\d{1,4})\/$/.exec(req.url || "");
		const binding = match ? getBindings(host)[Number(match[1])] : undefined;
		if (
			(!binding && (req.url !== "/.iyowa/wisp/" || !grants.length)) ||
			req.headers.origin !== `http://${host}` ||
			sockets.clients.size >= 64
		) {
			socket.destroy();
			return;
		}
		sockets.handleUpgrade(req, socket, head, (ws) => {
			if (binding) {
				bindConnection(ws, binding, grants);
				return;
			}
			class ScopedConnection extends wisp.ServerConnection {
				override create_stream(id: number, type: number, ip: string, p: number) {
					if (
						!isIP(ip) ||
						!grants.some(
							(g) =>
								g.address === ip && g.port === p && type === (g.protocol === "tcp" ? 1 : 2),
						)
					) {
						void this.send_close_packet(id, 0x42);
						return;
					}
					super.create_stream(id, type, ip, p);
				}
			}
			const conn = new ScopedConnection(ws, req.url || "", {
				wisp_version: req.headers["sec-websocket-protocol"] === "wisp-v2" ? 2 : 1,
			});
			void conn
				.setup()
				.then(() => conn.run())
				.catch(() => ws.close());
		});
	});
	return () => {
		for (const ws of sockets.clients) ws.terminate();
		sockets.close();
	};
}
