import { lookup } from "node:dns/promises";
import type { IncomingMessage } from "node:http";
import https from "node:https";
import ipaddr from "ipaddr.js";
import { MAX_BYTES } from "../runtime/bundle.ts";

// Pin the validated address to the actual TLS connection. Callers must validate each redirect.
export async function publicGet(url: URL, signal: AbortSignal, headers: Record<string, string> = {}) {
	if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443"))
		throw Error("Expected a public HTTPS URL on port 443");
	const hostname = url.hostname.replace(/^\[|\]$/g, "");
	const records = await lookup(hostname, { all: true });
	if (!records.length || records.some((r) => ipaddr.process(r.address).range() !== "unicast"))
		throw Error("Download address is not public");
	const record = records.find((r) => r.family === 4) || records[0];
	return new Promise<IncomingMessage>((ok, no) =>
		https
			.get(
				url,
				{
					agent: false,
					family: record.family,
					signal,
					lookup: (_h, _o, cb) => cb(null, record.address, record.family),
					headers: { ...headers, "User-Agent": "Iyowa-IWA-runtime", "Accept-Encoding": "identity" },
				},
				ok,
			)
			.once("error", no),
	);
}
export async function download(input: string, signal = AbortSignal.timeout(45000)) {
	let url = new URL(input);
	for (let i = 0; i <= 6; i++) {
		const res = await publicGet(url, signal);
		if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0) && res.headers.location) {
			res.destroy();
			url = new URL(res.headers.location, url);
			continue;
		}
		if (res.statusCode !== 200) {
			res.destroy();
			throw Error(`Download returned HTTP ${res.statusCode}`);
		}
		return { bytes: await readLimited(res, MAX_BYTES), url: url.href };
	}
	throw Error("Too many download redirects");
}
export async function readLimited(stream: IncomingMessage, limit: number) {
	if (Number(stream.headers?.["content-length"]) > limit) throw Error("File exceeds size limit");
	let length = 0;
	const parts = [];
	for await (const chunk of stream) {
		length += chunk.length;
		if (length > limit) throw Error("File exceeds size limit");
		parts.push(chunk);
	}
	return Buffer.concat(parts, length);
}
