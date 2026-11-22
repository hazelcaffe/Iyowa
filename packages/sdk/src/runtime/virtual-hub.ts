// SharedWorker: one in-app loopback network per app origin, shared by its windows and workers.
// Nothing here binds a host OS port. Each accepted TCP endpoint has independent ownership.
import { isLoopbackHost } from "../shared/policy.ts";

interface Endpoint {
	owner: MessagePort;
	id: string;
	host: string;
	port: number;
	kind: string;
	groups: Set<string>;
	peer?: Endpoint | null;
	share?: boolean;
	remoteHost?: string;
	remotePort?: number;
}
interface Message {
	id: string;
	type: string;
	host: string;
	port: number;
	share?: boolean;
	remoteHost?: string;
	remotePort?: number;
	address: string;
	seq?: number;
	data?: Uint8Array;
	loopback?: boolean;
}
const endpoints = new Map<string, Endpoint>(),
	listeners = new Map<string, Endpoint>(),
	datagrams = new Map<string, Set<Endpoint>>();
let serial = 0,
	ephemeral = 49151;
const loop = isLoopbackHost;
const group = (h: string) => /^ff[0-9a-f]{2}:/i.test(h) || /^(22[4-9]|23\d)\./.test(h);
const local = (h: string) => (h.includes(":") ? "::1" : "127.0.0.1");
const family = (h: string) => (h.includes(":") ? "6" : "4");
const addrKey = (h: string, p: number) => `${family(h)}:${p}`;
function ephemeralPort() {
	for (let i = 0; i < 16384; i++) {
		ephemeral = 49152 + ((ephemeral - 49151) % 16384);
		if (![...endpoints.values()].some((e) => e.port === ephemeral)) return ephemeral;
	}
	throw Error("No virtual ports available");
}
function emit(e: Endpoint, type: string, fields: Record<string, unknown> = {}) {
	e.owner.postMessage({ id: e.id, type, ...fields });
}
function close(e: Endpoint, notify = true) {
	if (!endpoints.delete(e.id)) return;
	if (e.kind === "listen") listeners.delete(addrKey(e.host, e.port));
	if (e.kind === "udp") {
		const k = addrKey(e.host, e.port),
			list = datagrams.get(k);
		list?.delete(e);
		if (!list?.size) datagrams.delete(k);
	}
	if (notify) emit(e, "close");
	if (e.peer) {
		const peer = e.peer;
		e.peer = null;
		peer.peer = null;
		close(peer);
	}
}
function message(owner: MessagePort, m: Message) {
	let e = endpoints.get(m.id);
	if (e && e.owner !== owner) return;
	if (m.type === "dispose") {
		for (const s of [...endpoints.values()]) if (s.owner === owner) close(s);
		owner.close();
		return;
	}
	if (["listen", "connect", "udp"].includes(m.type)) {
		if (e || endpoints.size >= 4096) throw Error("Endpoint unavailable");
		if (!loop(m.host) && !(m.type === "udp" && group(m.remoteHost || "")))
			throw Error("Only virtual loopback addresses can be bound");
		const host = m.host,
			port = m.port || ephemeralPort(),
			key = addrKey(host, port);
		e = {
			owner,
			id: m.id,
			host,
			port,
			kind: m.type,
			groups: new Set(),
			share: m.share,
			remoteHost: m.remoteHost,
			remotePort: m.remotePort,
		};
		if (m.type === "listen") {
			if (listeners.has(key)) throw Error("Address in use");
			listeners.set(key, e);
		}
		if (m.type === "connect") {
			const server = listeners.get(key);
			if (!server) throw Error("Connection refused");
			const peer = {
				owner: server.owner,
				id: `accepted-${++serial}`,
				kind: "tcp",
				host,
				port,
				peer: e,
				groups: new Set<string>(),
			};
			e.peer = peer;
			e.port = ephemeralPort();
			endpoints.set(peer.id, peer);
			emit(server, "accept", {
				socket: peer.id,
				info: {
					localAddress: local(host),
					localPort: port,
					remoteAddress: local(host),
					remotePort: e.port,
				},
			});
		}
		if (m.type === "udp") {
			let list = datagrams.get(key);
			if (list?.size && (!m.share || [...list].some((x) => !x.share))) throw Error("Address in use");
			if (!list) {
				list = new Set();
				datagrams.set(key, list);
			}
			list.add(e);
		}
		endpoints.set(e.id, e);
		emit(e, "open", {
			info: {
				localAddress: m.type === "connect" ? local(host) : host,
				localPort: e.port,
				...(m.type === "connect" ? { remoteAddress: host, remotePort: port } : {}),
			},
		});
		return;
	}
	if (!e) return;
	if (m.type === "close") {
		close(e);
		return;
	}
	if (m.type === "join" || m.type === "leave") {
		if (!group(m.address)) throw Error("Not a multicast address");
		e.groups[m.type === "join" ? "add" : "delete"](m.address);
	}
	if (m.type === "data") {
		if (e.kind === "udp") {
			const h = m.host,
				p = m.port,
				multicast = group(h);
			if (!loop(h) && !multicast) throw Error("No virtual route to destination");
			const targets = multicast
				? [...endpoints.values()].filter(
						(d) => d.kind === "udp" && d.port === p && d.groups.has(h) && m.loopback !== false,
					)
				: datagrams.get(addrKey(h, p)) || [];
			for (const d of targets)
				if (!d.remotePort || d.remotePort === e.port)
					emit(d, "data", { data: m.data, host: local(e.host), port: e.port });
		} else if (e.peer) emit(e.peer, "data", { data: m.data });
		else throw Error("Peer is closed");
	}
	if (m.seq) emit(e, "ack", { seq: m.seq });
}
(self as unknown as { onconnect: (e: MessageEvent) => void }).onconnect = ({ ports: [port] }) => {
	port.addEventListener("close", () => {
		for (const e of [...endpoints.values()]) if (e.owner === port) close(e, false);
	});
	port.onmessage = ({ data }: MessageEvent<Message>) => {
		try {
			message(port, data);
		} catch (e) {
			port.postMessage({
				type: "error",
				id: data.id,
				message: e instanceof Error ? e.message : String(e),
				seq: data.seq,
			});
		}
	};
};
