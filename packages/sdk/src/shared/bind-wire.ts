// Wisp has no BIND or ACCEPT operation. Real OS listeners use this small companion envelope:
// a JSON control header and a binary payload (zero-length UDP datagrams included).
export interface BindMessage {
	type: string;
	id: string;
	seq?: number;
	host?: string;
	port?: number;
	socket?: string;
	message?: string;
	share?: boolean;
	data?: Uint8Array;
	info?: { localAddress?: string; localPort?: number; remoteAddress?: string; remotePort?: number };
}

const encoder = new TextEncoder(),
	decoder = new TextDecoder();

export function pack(message: BindMessage): Uint8Array<ArrayBuffer> {
	const { data, ...fields } = message;
	const head = encoder.encode(JSON.stringify(fields));
	if (head.length > 4096) throw Error("Invalid binding header");
	const out = new Uint8Array(2 + head.length + (data?.length || 0));
	new DataView(out.buffer).setUint16(0, head.length);
	out.set(head, 2);
	if (data) out.set(data, 2 + head.length);
	return out;
}

export function unpack(bytes: Uint8Array): BindMessage {
	const n = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(0);
	if (n > 4096 || 2 + n > bytes.length) throw Error("Invalid binding header");
	const m: BindMessage = JSON.parse(decoder.decode(bytes.subarray(2, 2 + n)));
	if (typeof m.type !== "string" || typeof m.id !== "string") throw Error("Invalid binding packet");
	if (m.type === "data") m.data = bytes.subarray(2 + n);
	return m;
}
