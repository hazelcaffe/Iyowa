import { client } from "@mercuryworkshop/wisp-js/client";
import { type BindMessage, pack, unpack } from "./bind-wire.ts";
import { allows } from "./policy.ts";
import type { GuestConfig } from "./types.ts";

type Info = { localAddress?: string; localPort?: number; remoteAddress?: string; remotePort?: number };
type Open = Info & { readable: ReadableStream; writable?: WritableStream; multicastController?: object };
type Wire = {
	type: string;
	id: string;
	seq?: number;
	data?: Uint8Array;
	socket?: string;
	info?: Info;
	message?: string;
	host?: string;
	port?: number;
};
interface Options extends Info {
	multicastAllowAddressSharing?: boolean;
	multicastLoopback?: boolean;
	sendBufferSize?: number;
	receiveBufferSize?: number;
	keepAliveDelay?: number;
	backlog?: number;
}
const err = (message: string, name = "NetworkError") => new DOMException(message, name);
const loop = (h: string) => ["localhost", "127.0.0.1", "::1", "::", "0.0.0.0"].includes(h);
const multicast = (h: string) => /^ff[\da-f]{2}:/i.test(h) || /^(22[4-9]|23\d)\./.test(h);
function port(n: unknown, zero = false): number {
	if (typeof n !== "number" || !Number.isInteger(n) || n < (zero ? 0 : 1) || n > 65535)
		throw TypeError("Invalid port");
	return n;
}
function bytes(value: unknown) {
	if (ArrayBuffer.isView(value))
		return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
	if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
	throw TypeError("Expected a BufferSource");
}

export function installSockets(config: GuestConfig) {
	let hub: MessagePort | undefined;
	let supplied: MessagePort | undefined;
	const waiting: unknown[] = [];
	const routes = new Map<string, (m: Wire) => void>();
	const route = ({ data: m }: MessageEvent<Wire>) => routes.get(m.id)?.(m);
	const url = "/.iyowa/hub.js";
	const factory = (
		globalThis as {
			trustedTypes?: {
				createPolicy(
					name: string,
					rules: { createScriptURL: (v: string) => string },
				): { createScriptURL(v: string): unknown };
			};
		}
	).trustedTypes;
	let safeURL: string | undefined;
	function openPort() {
		if (!safeURL) {
			const policy = factory?.createPolicy("iyowa-loopback", {
				createScriptURL: (v: string) => {
					if (v !== url) throw TypeError("Invalid hub URL");
					return v;
				},
			});
			safeURL = (policy?.createScriptURL(url) ?? url) as string;
		}
		return new SharedWorker(safeURL, { name: "iyowa-loopback-v1" }).port;
	}
	if (
		typeof document !== "undefined" &&
		typeof SharedWorker !== "undefined" &&
		allows(config.manifest, "direct-sockets", config.id)
	) {
		const NativeWorker = globalThis.Worker;
		globalThis.Worker = new Proxy(NativeWorker, {
			construct(target, args: [string | URL, WorkerOptions?], newTarget) {
				const w = Reflect.construct(target, args, newTarget) as Worker;
				if (new URL(String(args[0]), location.href).origin === location.origin) {
					const p = openPort();
					w.postMessage({ iyowa: "socket-port" }, [p]);
				}
				return w;
			},
		});
	} else if (typeof document === "undefined" && typeof SharedWorker === "undefined") {
		addEventListener(
			"message",
			(e: MessageEvent) => {
				if (e.data?.iyowa === "socket-port" && e.ports[0] && !supplied) {
					e.stopImmediatePropagation();
					supplied = e.ports[0];
					supplied.onmessage = route;
					for (const m of waiting) supplied.postMessage(m);
					waiting.length = 0;
				}
			},
			{ capture: true },
		);
	}
	function worker() {
		if (typeof SharedWorker === "undefined") {
			if (supplied) return supplied;
			if (typeof document !== "undefined" || !("DedicatedWorkerGlobalScope" in globalThis))
				throw err("Loopback needs an application window or dedicated worker", "NotSupportedError");
			return { postMessage: (m: unknown) => waiting.push(m) };
		}
		if (!hub) {
			hub = openPort();
			hub.onmessage = route;
			if (typeof document !== "undefined")
				addEventListener(
					"pagehide",
					() => {
						hub?.postMessage({ type: "dispose" });
						hub = undefined;
					},
					{ once: true },
				);
		}
		return hub;
	}
	function requireFeature(name: string) {
		if (
			!allows(config.manifest, name, config.id) ||
			!allows(config.manifest, "cross-origin-isolated", config.id)
		)
			throw err(`Manifest does not grant ${name}`, "NotAllowedError");
	}
	const accepted = Symbol("accepted");
	class Socket {
		#open = Promise.withResolvers<Open>();
		#closed = Promise.withResolvers<void>();
		opened = this.#open.promise;
		closed = this.#closed.promise;
		id: string;
		info?: Open;
		ended = false;
		#controller?: ReadableStreamDefaultController | ReadableByteStreamController;
		#seq = 0;
		#pending = new Map<number, PromiseWithResolvers<void>>();
		#end?: () => void;
		#post = (message: BindMessage) => worker().postMessage(message);
		#send?: (data: Uint8Array) => Promise<void>;
		kind: "listen" | "tcp" | "udp";
		options: Options;
		constructor(kind: "listen" | "tcp" | "udp", options: Options, id = crypto.randomUUID() as string) {
			requireFeature("direct-sockets");
			this.id = id;
			this.kind = kind;
			this.options = options;
			this.opened.catch(() => {});
			this.closed.catch(() => {});
			for (const key of ["receiveBufferSize", "sendBufferSize", "backlog"] as const)
				if (
					options[key] !== undefined &&
					(!Number.isInteger(options[key]) || Number(options[key]) <= 0)
				)
					throw TypeError(`Invalid ${key}`);
		}
		command(type: string, fields: Record<string, unknown> = {}) {
			if (this.ended) return Promise.reject(err("Socket closed", "InvalidStateError"));
			const seq = ++this.#seq,
				p = Promise.withResolvers<void>();
			this.#pending.set(seq, p);
			this.#post({ id: this.id, type, seq, ...fields });
			return p.promise;
		}
		virtual(type: string, fields: Record<string, unknown>, post?: (message: BindMessage) => void) {
			if (post) this.#post = post;
			routes.set(this.id, (m) => {
				if (m.type === "open") this.ready(m.info || {});
				else if (m.type === "accept" && m.socket) {
					const s = new TCPSocket("", 1, {}, accepted, m.socket);
					s.virtual("accepted", {}, this.#post);
					s.ready(m.info || {});
					this.#controller?.enqueue(s as never);
				} else if (m.type === "data" && m.data) this.incoming(m.data, m.host, m.port);
				else if (m.type === "close") this.finish();
				else if (m.seq) {
					const p = this.#pending.get(m.seq);
					this.#pending.delete(m.seq);
					if (m.type === "error") p?.reject(err(m.message || "Socket error"));
					else p?.resolve();
				} else if (m.type === "error") this.finish(err(m.message || "Socket error"));
			});
			this.#end = () => this.#post({ id: this.id, type: "close" });
			if (type !== "accepted")
				try {
					this.#post({ type, id: this.id, ...fields });
				} catch (e) {
					this.finish(e);
				}
		}
		bind(type: "udp" | "listen", host: string, p: number, extra: Record<string, unknown> = {}) {
			const i = config.bindings.findIndex(
				(g) => g.address === host && g.port === p && g.protocol === (type === "udp" ? "udp" : "tcp"),
			);
			if (i < 0) {
				this.virtual(type, { host, port: p, ...extra });
				return;
			}
			const ws = new WebSocket(`ws://${location.host}/.iyowa/bind/${i}/`);
			ws.binaryType = "arraybuffer";
			const ids = new Set([this.id]);
			const send = (m: BindMessage) => {
				if (ws.readyState !== WebSocket.OPEN) throw err("Loopback binding disconnected");
				ws.send(pack(m));
			};
			this.#end = () => ws.close();
			ws.onopen = () => {
				if (this.ended) {
					ws.close();
					return;
				}
				this.virtual(type, { host, port: p }, send);
			};
			ws.onmessage = (e) => {
				const m = unpack(new Uint8Array(e.data));
				if (m.socket) ids.add(m.socket);
				routes.get(m.id)?.(m);
				if (m.type === "close" || (m.type === "error" && !m.seq)) ids.delete(m.id);
			};
			ws.onclose = () => {
				for (const id of ids)
					routes.get(id)?.({ id, type: "error", message: "Loopback binding closed" });
				if (!this.ended) this.finish(err("Loopback binding unavailable"));
			};
		}
		relay(host: string, p: number) {
			const conn = new client.ClientConnection(`ws://${location.host}/.iyowa/wisp/`);
			const timer = setTimeout(() => {
				this.finish(err("Wisp connection timed out"));
				conn.close();
			}, 10000);
			this.#end = () => conn.close();
			conn.onopen = () => {
				clearTimeout(timer);
				if (this.ended) {
					conn.close();
					return;
				}
				try {
					const stream = conn.create_stream(host, p, this.kind);
					stream.onmessage = (data) => this.incoming(data);
					stream.onclose = (reason) => {
						this.finish(reason === 1 ? undefined : err(`Wisp close reason ${reason}`));
						conn.close();
					};
					this.#send = async (data) => {
						const stride = this.kind === "tcp" ? 64 * 1024 : Math.max(1, data.length);
						for (let offset = 0; offset < data.length || offset === 0; offset += stride) {
							while (
								!this.ended &&
								(conn.ws.bufferedAmount > 1024 * 1024 || stream.send_buffer.length >= 32)
							)
								await new Promise((ok) => setTimeout(ok, 4));
							if (this.ended) throw err("Socket closed");
							stream.send(data.subarray(offset, offset + stride));
						}
					};
					this.#end = () => {
						stream.close();
						conn.close();
					};
					this.ready({ remoteAddress: host, remotePort: p });
				} catch (e) {
					this.finish(e);
					conn.close();
				}
			};
			conn.onerror = conn.onclose = () => {
				clearTimeout(timer);
				if (!this.ended) this.finish(err("Wisp connection closed"));
			};
		}
		incoming(data: Uint8Array, host?: string, p?: number) {
			if (this.ended) return;
			if (this.kind === "tcp")
				(this.#controller as ReadableByteStreamController).enqueue(new Uint8Array(data));
			else
				this.#controller?.enqueue({
					data: new Uint8Array(data),
					remoteAddress: this.options.remotePort ? null : host,
					remotePort: this.options.remotePort ? null : p,
				} as never);
		}
		ready(info: Info) {
			const tcp = this.kind === "tcp",
				listen = this.kind === "listen",
				opts = this.options;
			const readable = tcp
				? new ReadableStream({
						type: "bytes",
						start: (c) => {
							this.#controller = c;
						},
						cancel: () => this.shutdown(),
					})
				: new ReadableStream({
						start: (c) => {
							this.#controller = c;
						},
						cancel: () => this.shutdown(),
					});
			const writable = listen
				? undefined
				: new WritableStream({
						write: async (value) => {
							const data = bytes(tcp ? value : value?.data);
							if (tcp && !data.length) return;
							if (!tcp && data.byteLength > 65507) throw TypeError("Datagram too large");
							if (this.#send) return this.#send(data);
							const host = opts.remoteAddress || value?.remoteAddress,
								p = opts.remotePort || value?.remotePort;
							if (!tcp) {
								port(p);
								if (!host) throw TypeError("Expected datagram destination");
								if (multicast(host)) requireFeature("direct-sockets-multicast");
							}
							if (tcp && data.length > 65536) {
								for (let off = 0; off < data.length; off += 65536)
									await this.command("data", { data: data.subarray(off, off + 65536) });
								return;
							}
							return this.command("data", {
								data,
								host,
								port: p,
								loopback: opts.multicastLoopback,
							});
						},
						close: () => this.shutdown(),
						abort: () => this.shutdown(),
					});
			const membership = (op: string, h: string) => {
				requireFeature("direct-sockets-multicast");
				return this.command(op, { address: h });
			};
			this.info = {
				...info,
				readable,
				...(writable ? { writable } : {}),
				...(this.kind === "udp"
					? opts.remotePort
						? { remoteAddress: opts.remoteAddress, remotePort: opts.remotePort }
						: {
								multicastController: {
									joinGroup: (h: string) => membership("join", h),
									leaveGroup: (h: string) => membership("leave", h),
								},
							}
					: {}),
			};
			this.#open.resolve(this.info);
		}
		finish(error?: unknown) {
			if (this.ended) return;
			this.ended = true;
			routes.delete(this.id);
			for (const p of this.#pending.values()) p.reject(error || err("Socket closed"));
			this.#pending.clear();
			if (error) {
				this.#controller?.error(error);
				this.#open.reject(error);
				this.#closed.reject(error);
			} else {
				try {
					const c = this.#controller;
					c?.close();
					if (c && "byobRequest" in c) c.byobRequest?.respond(0);
				} catch {
					/* already canceled */
				}
				this.#open.reject(err("Socket closed", "AbortError"));
				this.#closed.resolve();
			}
		}
		shutdown() {
			if (!this.ended) {
				this.#end?.();
				this.finish();
			}
			return this.closed;
		}
		close() {
			if (!this.ended && (this.info?.readable.locked || this.info?.writable?.locked))
				return Promise.reject(err("Release stream locks before closing", "InvalidStateError"));
			return this.shutdown();
		}
	}
	function permitted(protocol: string, address: string, p: number) {
		return config.grants.some((g) => g.protocol === protocol && g.address === address && g.port === p);
	}
	class TCPSocket extends Socket {
		constructor(host: string, p: number, opts: Options = {}, token?: symbol, id?: string) {
			super("tcp", opts, id);
			if (token === accepted) return;
			port(p);
			if (typeof host !== "string" || !host) throw TypeError("Missing remote address");
			if (permitted("tcp", host, p)) this.relay(host, p);
			else if (loop(host)) this.virtual("connect", { host, port: p });
			else this.finish(err("No Wisp grant for destination", "NotAllowedError"));
		}
	}
	class TCPServerSocket extends Socket {
		constructor(address: string, opts: Options = {}) {
			super("listen", opts);
			this.bind("listen", address, port(opts.localPort ?? 0, true));
		}
	}
	class UDPSocket extends Socket {
		constructor(opts: Options) {
			super("udp", opts);
			const h = opts.remoteAddress,
				p = opts.remotePort;
			if (
				(h === undefined) !== (p === undefined) ||
				(!h && !opts.localAddress) ||
				(h && (opts.localAddress !== undefined || opts.localPort !== undefined))
			)
				throw TypeError("Specify either one remote endpoint or a local bind address");
			if (h && p !== undefined) {
				port(p);
				if (multicast(h)) requireFeature("direct-sockets-multicast");
				if (permitted("udp", h, p)) {
					this.relay(h, p);
					return;
				}
				if (!loop(h) && !multicast(h)) {
					this.finish(err("No Wisp grant for destination", "NotAllowedError"));
					return;
				}
			}
			if (!h && opts.localAddress) {
				this.bind("udp", opts.localAddress, port(opts.localPort ?? 0, true), {
					share: opts.multicastAllowAddressSharing,
				});
				return;
			}
			this.virtual("udp", {
				host: opts.localAddress || (h?.includes(":") ? "::1" : "127.0.0.1"),
				port: port(opts.localPort ?? 0, true),
				remoteHost: h,
				remotePort: p,
				share: opts.multicastAllowAddressSharing,
			});
		}
	}
	Object.assign(globalThis, { TCPSocket, TCPServerSocket, UDPSocket });
}
