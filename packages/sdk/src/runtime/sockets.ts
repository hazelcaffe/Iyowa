import { client as wispClient } from "@mercuryworkshop/wisp-js/client";
import { type BindMessage, pack, unpack } from "../shared/bind-wire.ts";
import { allowsIsolated, isLoopbackHost, isPrivateHost } from "../shared/policy.ts";
import type { GuestConfig } from "../shared/types.ts";
import type { Bridge, SocketEvent } from "./bridge.ts";

const HOST_BLOCKED = 0x48;
const CHUNK = 64 * 1024;

interface Address {
	localAddress?: string;
	localPort?: number;
	remoteAddress?: string;
	remotePort?: number;
}
interface Peer {
	host: string;
	port: number;
}
/** Bytes or datagrams out of one connection. */
interface Channel {
	send(data: Uint8Array, to?: Peer): Promise<void>;
	close(): void;
	join?(group: string): Promise<void>;
	leave?(group: string): Promise<void>;
}
/** Events into one connection. */
interface Sink {
	data(data: Uint8Array<ArrayBuffer>, from?: Peer): void;
	accept?(attach: (sink: Sink) => Channel, info: Address): void;
	end(error?: unknown): void;
}
interface Opened {
	channel: Channel;
	info: Address;
	route: SocketEvent["route"];
}
interface Options extends Address {
	noDelay?: boolean;
	keepAliveDelay?: number;
	sendBufferSize?: number;
	receiveBufferSize?: number;
	backlog?: number;
	ipv6Only?: boolean;
	dnsQueryType?: "ipv4" | "ipv6";
	multicastTimeToLive?: number;
	multicastLoopback?: boolean;
	multicastAllowAddressSharing?: boolean;
}

const networkError = (message: string, name = "NetworkError") => new DOMException(message, name);
const isMulticast = (h: string) => /^ff[\da-f]{2}:/i.test(h) || /^(22[4-9]|23\d)\./.test(h);
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const wsBase = () => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/.iyowa/`;

function port(value: unknown, zero = false): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < (zero ? 0 : 1) || value > 65535)
		throw new TypeError("Invalid port");
	return value;
}
function copy(value: unknown): Uint8Array<ArrayBuffer> {
	if (ArrayBuffer.isView(value))
		return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
	if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
	throw new TypeError("Expected a BufferSource");
}
const label = (h?: string, p?: number) =>
	h ? `${h.includes(":") ? `[${h}]` : h}${p === undefined ? "" : `:${p}`}` : undefined;

export function installSockets(
	config: GuestConfig,
	bridge: Bridge | undefined,
	report: (e: SocketEvent) => void,
) {
	const { manifest, id } = config;
	const enabled = allowsIsolated(manifest, "direct-sockets", id);
	const privateCapable = enabled && allowsIsolated(manifest, "direct-sockets-private", id);

	function require(feature: string) {
		if (!allowsIsolated(manifest, feature, id))
			throw networkError(`The app manifest does not grant "${feature}"`, "NotAllowedError");
	}
	/** Real local-network access: manifest capability and the user's decision (asked once, in windows). */
	async function localAccess(reason: string, ask = true): Promise<boolean> {
		if (!privateCapable) return false;
		if (!bridge || !ask) return config.permissions["local-network"] === "granted";
		return (await bridge.permission("local-network", reason)) === "granted";
	}

	// ── In-app loopback network (SharedWorker hub) ────────────────────────────────────────────────
	let hubPort: MessagePort | undefined;
	let suppliedPort: MessagePort | undefined;
	const queued: unknown[] = [];
	const hubRoutes = new Map<string, (m: BindMessage & { info?: Address }) => void>();
	const route = ({ data }: MessageEvent) => hubRoutes.get(data.id)?.(data);
	const hubURL = "/.iyowa/hub.js";
	let trustedHubURL: string | undefined;
	function openHubPort(): MessagePort {
		if (!trustedHubURL) {
			// Bundled CSPs commonly require Trusted Types for script URLs.
			const tt = (
				globalThis as {
					trustedTypes?: {
						createPolicy(
							n: string,
							r: { createScriptURL(v: string): string },
						): { createScriptURL(v: string): unknown };
					};
				}
			).trustedTypes;
			const policy = tt?.createPolicy("iyowa-sockets", {
				createScriptURL: (v) => {
					if (v !== hubURL) throw new TypeError("Unexpected worker URL");
					return v;
				},
			});
			trustedHubURL = (policy?.createScriptURL(hubURL) ?? hubURL) as string;
		}
		return new SharedWorker(trustedHubURL, { name: "iyowa-loopback-v1" }).port;
	}
	if (typeof document !== "undefined" && typeof SharedWorker !== "undefined" && enabled) {
		// Dedicated workers can't construct SharedWorkers; hand each same-origin worker a hub port.
		const NativeWorker = globalThis.Worker;
		globalThis.Worker = new Proxy(NativeWorker, {
			construct(target, args: [string | URL, WorkerOptions?], newTarget) {
				const worker = Reflect.construct(target, args, newTarget) as Worker;
				if (new URL(String(args[0]), location.href).origin === location.origin) {
					const port = openHubPort();
					worker.postMessage({ iyowa: "socket-port" }, [port]);
				}
				return worker;
			},
		});
	} else if (typeof document === "undefined" && typeof SharedWorker === "undefined") {
		addEventListener(
			"message",
			(e: MessageEvent) => {
				if (e.data?.iyowa !== "socket-port" || !e.ports[0] || suppliedPort) return;
				e.stopImmediatePropagation();
				suppliedPort = e.ports[0];
				suppliedPort.onmessage = route;
				for (const m of queued.splice(0)) suppliedPort.postMessage(m);
			},
			{ capture: true },
		);
	}
	function hub(): { postMessage(m: unknown): void } {
		if (typeof SharedWorker === "undefined") {
			if (suppliedPort) return suppliedPort;
			if (typeof document !== "undefined")
				throw networkError("Loopback is unavailable here", "NotSupportedError");
			return { postMessage: (m) => queued.push(m) };
		}
		if (!hubPort) {
			hubPort = openHubPort();
			hubPort.onmessage = route;
			if (typeof document !== "undefined")
				addEventListener(
					"pagehide",
					() => {
						hubPort?.postMessage({ type: "dispose" });
						hubPort = undefined;
					},
					{ once: true },
				);
		}
		return hubPort;
	}

	/** Connect a sink to messages for `id` on a message-based transport (hub or system binding). */
	function attach(
		id: string,
		sink: Sink,
		post: (m: BindMessage) => void,
		routes: Map<string, (m: BindMessage & { info?: Address }) => void>,
		reopen: (id: string) => (sink: Sink) => Channel,
		onOpen?: (info: Address) => void,
		onFail?: (e: unknown) => void,
	): Channel {
		let seq = 0,
			opened = !onOpen;
		const acks = new Map<number, PromiseWithResolvers<void>>();
		const command = (type: string, fields: Partial<BindMessage>) => {
			const n = ++seq,
				p = Promise.withResolvers<void>();
			acks.set(n, p);
			try {
				post({ id, type, seq: n, ...fields });
			} catch (e) {
				acks.delete(n);
				p.reject(e);
			}
			return p.promise;
		};
		const end = (error?: unknown) => {
			routes.delete(id);
			for (const p of acks.values()) p.reject(error ?? networkError("Socket closed"));
			acks.clear();
			if (!opened) onFail?.(error ?? networkError("Socket closed"));
			else sink.end(error);
		};
		routes.set(id, (m) => {
			if (m.seq && acks.has(m.seq)) {
				const p = acks.get(m.seq);
				acks.delete(m.seq);
				if (m.type === "error") p?.reject(networkError(m.message || "Socket error"));
				else p?.resolve();
				return;
			}
			if (m.type === "open") {
				opened = true;
				onOpen?.(m.info || {});
			} else if (m.type === "accept" && m.socket) sink.accept?.(reopen(m.socket), m.info || {});
			else if (m.type === "data" && m.data)
				sink.data(
					new Uint8Array(m.data),
					m.host && m.port ? { host: m.host, port: m.port } : undefined,
				);
			else if (m.type === "close") end();
			else if (m.type === "error") end(networkError(m.message || "Socket error"));
		});
		return {
			send: (data, to) => command("data", { data, host: to?.host, port: to?.port }),
			close: () => {
				routes.delete(id);
				try {
					post({ id, type: "close" });
				} catch {
					/* The transport is already gone. */
				}
			},
			join: (group) => command("join", { host: group, address: group } as Partial<BindMessage>),
			leave: (group) => command("leave", { host: group, address: group } as Partial<BindMessage>),
		};
	}

	function hubOpen(
		type: "listen" | "connect" | "udp",
		fields: Record<string, unknown>,
		sink: Sink,
	): Promise<Opened> {
		const sid = crypto.randomUUID();
		const post = (m: BindMessage) => hub().postMessage(m);
		const reopen = (child: string) => (s: Sink) => attach(child, s, post, hubRoutes, reopen);
		return new Promise((ok, no) => {
			const channel = attach(
				sid,
				sink,
				post,
				hubRoutes,
				reopen,
				(info) => ok({ channel, info, route: "in-app" }),
				no,
			);
			try {
				post({ type, id: sid, ...fields } as BindMessage);
			} catch (e) {
				hubRoutes.delete(sid);
				no(e);
			}
		});
	}

	// ── Host OS listeners (/.iyowa/bind/) ─────────────────────────────────────────────────────────
	function bindOpen(
		type: "listen" | "udp",
		host: string,
		localPort: number,
		share: boolean,
		sink: Sink,
	): Promise<Opened> {
		const ws = new WebSocket(`${wsBase()}bind/`);
		ws.binaryType = "arraybuffer";
		const routes = new Map<string, (m: BindMessage & { info?: Address }) => void>();
		const post = (m: BindMessage) => {
			if (ws.readyState !== WebSocket.OPEN) throw networkError("System socket closed");
			ws.send(pack(m));
		};
		const reopen = (child: string) => (s: Sink) => attach(child, s, post, routes, reopen);
		const sid = crypto.randomUUID();
		ws.onmessage = (e) => {
			const m = unpack(new Uint8Array(e.data as ArrayBuffer));
			routes.get(m.id)?.(m);
		};
		return new Promise((ok, no) => {
			const channel = attach(
				sid,
				sink,
				post,
				routes,
				reopen,
				(info) => ok({ channel, info, route: "system" }),
				no,
			);
			ws.onopen = () => post({ type, id: sid, host, port: localPort, share });
			ws.onclose = () => {
				for (const handler of [...routes.values()])
					handler({ type: "error", id: "", message: "System socket closed" });
			};
		});
	}

	// ── Network relay (Wisp over /.iyowa/wisp/) ───────────────────────────────────────────────────
	type WispConnection = InstanceType<typeof wispClient.ClientConnection>;
	let wisp: Promise<WispConnection> | undefined;
	function relay(): Promise<WispConnection> {
		wisp ??= new Promise<WispConnection>((ok, no) => {
			const c = new wispClient.ClientConnection(`${wsBase()}wisp/`);
			const timer = setTimeout(() => {
				no(networkError("Timed out reaching the Iyowa network relay"));
				c.close();
			}, 10000);
			c.onopen = () => {
				clearTimeout(timer);
				ok(c);
			};
			c.onerror = c.onclose = () => {
				clearTimeout(timer);
				wisp = undefined;
				no(networkError("The Iyowa network relay is unavailable"));
			};
		});
		return wisp;
	}
	async function relayOpen(
		host: string,
		remotePort: number,
		type: "tcp" | "udp",
		sink: Sink,
	): Promise<Opened> {
		const c = await relay();
		const stream = c.create_stream(host, remotePort, type);
		return new Promise((ok, no) => {
			let opened = false,
				closed = false;
			const channel: Channel = {
				async send(data) {
					const stride = type === "tcp" ? CHUNK : Math.max(1, data.length);
					for (let offset = 0; offset < data.length || offset === 0; offset += stride) {
						while (!closed && (c.ws.bufferedAmount > 1 << 20 || stream.send_buffer.length >= 32))
							await sleep(4);
						if (closed) throw networkError("Socket closed");
						stream.send(data.subarray(offset, offset + stride));
						if (data.length === 0) break;
					}
				},
				close() {
					if (!closed) stream.close(0x02);
					closed = true;
				},
			};
			const info = { remoteAddress: host, remotePort };
			const timer =
				type === "tcp"
					? setTimeout(() => {
							if (opened) return;
							channel.close();
							no(networkError(`Connecting to ${label(host, remotePort)} timed out`));
						}, 30000)
					: undefined;
			const done = () => {
				opened = true;
				clearTimeout(timer);
				ok({ channel, info, route: "network" });
			};
			if (type === "tcp") {
				// The relay acknowledges a completed TCP handshake with an early CONTINUE packet.
				const received = stream.continue_received.bind(stream);
				stream.continue_received = (n: number) => {
					received(n);
					if (!opened) done();
				};
			}
			stream.onmessage = (data) => sink.data(new Uint8Array(data));
			stream.onclose = (reason) => {
				closed = true;
				clearTimeout(timer);
				if (!opened) {
					const blocked = reason === HOST_BLOCKED;
					no(
						Object.assign(
							networkError(
								blocked
									? `Connections to ${label(host, remotePort)} are not permitted`
									: `Could not connect to ${label(host, remotePort)}`,
								blocked ? "NotAllowedError" : "NetworkError",
							),
							{ reason },
						),
					);
					return;
				}
				sink.end(
					reason === 0x01 || reason === 0x02
						? undefined
						: networkError(`Connection lost (Wisp ${reason})`),
				);
			};
			if (type === "udp") done();
		});
	}
	/** Relay a connection, asking for local-network access if the relay reports a private address. */
	async function network(
		host: string,
		remotePort: number,
		type: "tcp" | "udp",
		sink: Sink,
	): Promise<Opened> {
		const reason = `${type === "tcp" ? "connect to" : "send datagrams to"} ${label(host, remotePort)}`;
		if (isPrivateHost(host) && !(await localAccess(reason)))
			throw networkError(`Local network access to ${host} was not allowed`, "NotAllowedError");
		try {
			return await relayOpen(host, remotePort, type, sink);
		} catch (e) {
			const blocked = (e as { reason?: number }).reason === HOST_BLOCKED;
			// A public-looking name resolved to a private address: ask, then retry once.
			if (blocked && config.permissions["local-network"] === "prompt" && (await localAccess(reason)))
				return relayOpen(host, remotePort, type, sink);
			throw e;
		}
	}

	// ── Socket objects ────────────────────────────────────────────────────────────────────────────
	const accepted = Symbol("accepted");
	const adopt = Symbol("adopt");
	type Kind = SocketEvent["kind"];

	class SocketBase {
		readonly #opened = Promise.withResolvers<Record<string, unknown>>();
		readonly #closed = Promise.withResolvers<void>();
		readonly #kind: Kind;
		readonly #id = crypto.randomUUID();
		#channel?: Channel;
		#controller?: ReadableStreamDefaultController | ReadableByteStreamController;
		#info?: Record<string, unknown> & { readable?: ReadableStream; writable?: WritableStream };
		#route: SocketEvent["route"] = "in-app";
		#ended = false;
		#sent = 0;
		#received = 0;
		protected options: Options;

		constructor(kind: Kind, options: Options) {
			if (!enabled)
				throw networkError('The app manifest does not grant "direct-sockets"', "NotAllowedError");
			this.#kind = kind;
			this.options = options;
			this.#opened.promise.catch(() => {});
			this.#closed.promise.catch(() => {});
			for (const key of ["receiveBufferSize", "sendBufferSize", "backlog"] as const) {
				const v = options[key];
				if (v !== undefined && (!Number.isInteger(v) || v <= 0))
					throw new TypeError(`Invalid ${key}`);
			}
		}
		get opened() {
			return this.#opened.promise;
		}
		get closed() {
			return this.#closed.promise;
		}
		protected report(state: SocketEvent["state"], error?: unknown) {
			const info = this.#info as Address | undefined;
			report({
				id: this.#id,
				kind: this.#kind,
				route: this.#route,
				state,
				local: label(info?.localAddress, info?.localPort),
				remote: label(
					info?.remoteAddress ?? this.options.remoteAddress,
					info?.remotePort ?? this.options.remotePort,
				),
				error: error ? String((error as Error).message ?? error) : undefined,
				sent: this.#sent,
				received: this.#received,
			});
		}
		protected sink(): Sink {
			return {
				data: (data, from) => this.#incoming(data, from),
				accept: (attachChannel, info) => {
					const socket = new TCPSocket("", 1, {}, accepted);
					socket[adopt](attachChannel, info, this.#route);
					(this.#controller as ReadableStreamDefaultController).enqueue(socket);
				},
				end: (error) => this.#finish(error),
			};
		}
		protected start(open: () => Promise<Opened>) {
			this.report("opening");
			open().then(
				(o) => this.#ready(o.channel, o.info, o.route),
				(e) => this.#finish(e),
			);
		}
		[adopt](attachChannel: (sink: Sink) => Channel, info: Address, route: SocketEvent["route"]) {
			this.#ready(attachChannel(this.sink()), info, route);
		}
		#incoming(data: Uint8Array<ArrayBuffer>, from?: Peer) {
			if (this.#ended || !this.#controller) return;
			this.#received += data.byteLength;
			if (this.#kind === "tcp") (this.#controller as ReadableByteStreamController).enqueue(data);
			else
				(this.#controller as ReadableStreamDefaultController).enqueue({
					data,
					remoteAddress: this.options.remotePort ? null : (from?.host ?? null),
					remotePort: this.options.remotePort ? null : (from?.port ?? null),
				});
		}
		#ready(channel: Channel, info: Address, route: SocketEvent["route"]) {
			if (this.#ended) {
				channel.close();
				return;
			}
			this.#channel = channel;
			this.#route = route;
			const kind = this.#kind,
				opts = this.options;
			const readable =
				kind === "tcp"
					? new ReadableStream({
							type: "bytes",
							start: (c) => {
								this.#controller = c;
							},
							cancel: () => this.#shutdown(),
						})
					: new ReadableStream(
							{
								start: (c) => {
									this.#controller = c;
								},
								cancel: () => this.#shutdown(),
							},
							{
								highWaterMark: opts.receiveBufferSize
									? Math.max(1, opts.receiveBufferSize >> 10)
									: 64,
							},
						);
			const writable =
				kind === "tcp-server"
					? undefined
					: new WritableStream({
							write: async (value) => {
								if (kind === "tcp") {
									const data = copy(value);
									if (data.length) {
										this.#sent += data.length;
										await channel.send(data);
									}
									return;
								}
								const message = value as {
									data?: unknown;
									remoteAddress?: string;
									remotePort?: number;
								};
								const data = copy(message?.data);
								if (data.byteLength > 65507) throw new TypeError("Datagram too large");
								let to: Peer | undefined;
								if (!opts.remotePort) {
									if (!message.remoteAddress)
										throw new TypeError("Bound UDP sockets need a remoteAddress");
									to = { host: message.remoteAddress, port: port(message.remotePort) };
									if (isMulticast(to.host)) require("direct-sockets-multicast");
								}
								this.#sent += data.byteLength;
								await channel.send(data, to);
							},
							close: () => this.#shutdown(),
							abort: () => this.#shutdown(),
						});
			const joined: string[] = [];
			const membership = async (op: "join" | "leave", group: string) => {
				require("direct-sockets-multicast");
				if (!isMulticast(group)) throw new TypeError("Not a multicast group address");
				await channel[op]?.(group);
				if (op === "join" && !joined.includes(group)) joined.push(group);
				if (op === "leave") joined.splice(joined.indexOf(group) >>> 0, 1);
			};
			this.#info = {
				...info,
				readable,
				...(writable ? { writable } : {}),
				...(kind === "udp"
					? opts.remotePort
						? { remoteAddress: opts.remoteAddress, remotePort: opts.remotePort }
						: {
								multicastController: {
									joinGroup: (g: string) => membership("join", g),
									leaveGroup: (g: string) => membership("leave", g),
									get joinedGroups() {
										return Object.freeze([...joined]);
									},
								},
							}
					: {}),
			};
			this.#opened.resolve(this.#info);
			this.report("open");
		}
		#finish(error?: unknown) {
			if (this.#ended) return;
			this.#ended = true;
			if (error) {
				const e =
					error instanceof DOMException
						? error
						: networkError(String((error as Error)?.message ?? error));
				try {
					this.#controller?.error(e);
				} catch {
					/* Stream already closed. */
				}
				this.#opened.reject(e);
				this.#closed.reject(e);
				this.report("failed", e);
				return;
			}
			try {
				const c = this.#controller;
				c?.close();
				if (c && "byobRequest" in c) c.byobRequest?.respond(0);
			} catch {
				/* Stream already canceled. */
			}
			this.#opened.reject(networkError("Socket closed", "AbortError"));
			this.#closed.resolve();
			this.report("closed");
		}
		#shutdown() {
			if (!this.#ended) {
				this.#channel?.close();
				this.#finish();
			}
			return this.closed;
		}
		close(): Promise<void> {
			const info = this.#info;
			if (!this.#ended && (info?.readable?.locked || info?.writable?.locked))
				return Promise.reject(
					networkError("Release stream locks before closing", "InvalidStateError"),
				);
			return this.#shutdown();
		}
	}

	class TCPSocket extends SocketBase {
		constructor(remoteAddress: string, remotePort: number, options: Options = {}, token?: symbol) {
			super("tcp", { ...options, remoteAddress, remotePort });
			if (token === accepted) return;
			port(remotePort);
			if (typeof remoteAddress !== "string" || !remoteAddress)
				throw new TypeError("Missing remote address");
			const host = remoteAddress.replace(/^\[|\]$/g, "");
			this.start(async () => {
				if (isLoopbackHost(host)) {
					try {
						return await hubOpen("connect", { host, port: remotePort }, this.sink());
					} catch (e) {
						// No in-app listener: a granted app may reach real local services instead.
						if (!privateCapable)
							throw networkError(`Connection to ${label(host, remotePort)} refused`);
						void e;
					}
				}
				return network(host, remotePort, "tcp", this.sink());
			});
		}
	}

	class TCPServerSocket extends SocketBase {
		constructor(localAddress: string, options: Options = {}) {
			super("tcp-server", { ...options, localAddress });
			if (typeof localAddress !== "string" || !localAddress)
				throw new TypeError("Missing local address");
			const host = localAddress.replace(/^\[|\]$/g, "");
			const localPort = port(options.localPort ?? 0, true);
			this.start(async () => {
				if (await localAccess(`accept connections on ${label(host, localPort || undefined)}`))
					return bindOpen("listen", host, localPort, false, this.sink());
				if (!isLoopbackHost(host))
					throw networkError(`Listening on ${host} needs local network access`, "NotAllowedError");
				return hubOpen("listen", { host, port: localPort }, this.sink());
			});
		}
	}

	class UDPSocket extends SocketBase {
		constructor(options: Options) {
			super("udp", { ...options });
			const remote = options.remoteAddress?.replace(/^\[|\]$/g, ""),
				remotePort = options.remotePort,
				localHost = options.localAddress?.replace(/^\[|\]$/g, "");
			if (
				(remote === undefined) !== (remotePort === undefined) ||
				(!remote && !localHost) ||
				(remote && localHost !== undefined)
			)
				throw new TypeError("Specify either remoteAddress and remotePort, or localAddress");
			if (remote && remotePort !== undefined) {
				port(remotePort);
				if (isMulticast(remote)) require("direct-sockets-multicast");
				this.start(async () => {
					// Loopback and multicast stay in-app unless the user already granted local access.
					if ((isLoopbackHost(remote) || isMulticast(remote)) && !(await localAccess("", false))) {
						const opened = await hubOpen(
							"udp",
							{
								host: remote.includes(":") ? "::1" : "127.0.0.1",
								port: 0,
								remoteHost: remote,
								remotePort,
							},
							this.sink(),
						);
						const send = opened.channel.send;
						opened.channel.send = (data, to) =>
							send(data, to ?? { host: remote, port: remotePort });
						return opened;
					}
					return network(remote, remotePort, "udp", this.sink());
				});
				return;
			}
			const host = localHost ?? "";
			const localPort = port(options.localPort ?? 0, true);
			const share = !!options.multicastAllowAddressSharing;
			this.start(async () => {
				if (await localAccess(`receive datagrams on ${label(host, localPort || undefined)}`))
					return bindOpen("udp", host, localPort, share, this.sink());
				if (!isLoopbackHost(host))
					throw networkError(`Binding ${host} needs local network access`, "NotAllowedError");
				return hubOpen("udp", { host, port: localPort, share }, this.sink());
			});
		}
	}

	for (const [name, value] of Object.entries({ TCPSocket, TCPServerSocket, UDPSocket }))
		Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
