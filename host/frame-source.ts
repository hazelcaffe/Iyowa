import type { IncomingHttpHeaders, ServerResponse } from "node:http";
import { publicGet, readLimited } from "./download.ts";

/** Source transport for a Scramjet partition. The caller supplies a path on its own
 * virtual origin, never arbitrary proxy headers, credentials, request bodies or hosts. */
export function frameSourceAllowed(h: IncomingHttpHeaders, partition: string) {
	if (h["x-frame-options"] || h["content-security-policy"]) return false;
	return (
		h["x-iyowa-embed"] === "allow" ||
		h["access-control-allow-origin"] === "*" ||
		h["access-control-allow-origin"] === partition
	);
}
export async function serveFrameSource(
	virtual: string,
	path: string,
	partition: string,
	res: ServerResponse,
) {
	const target = new URL(path, virtual);
	if (target.origin !== virtual || !path.startsWith("/") || target.username || target.password)
		throw Error("Path is outside the frame partition");
	const r = await publicGet(target, AbortSignal.timeout(12000), { Origin: partition });
	try {
		if ([301, 302, 303, 307, 308].includes(r.statusCode || 0) && r.headers.location) {
			const next = new URL(r.headers.location, target);
			if (next.protocol !== "https:" || next.username || next.password)
				throw Error("Unsupported frame redirect");
			res.writeHead(200, { "X-Iyowa-Redirect": next.href });
			res.end();
			return;
		}
		if (!frameSourceAllowed(r.headers, partition))
			throw Error(`${target.hostname} does not permit this page to be displayed in a managed frame.`);
		if (r.headers["content-encoding"] && r.headers["content-encoding"] !== "identity")
			throw Error("Unexpected compressed frame source");
		const body = await readLimited(r, 16 * 1024 * 1024);
		res.writeHead(200, {
			"Content-Type": "application/octet-stream",
			"Cross-Origin-Resource-Policy": "same-origin",
			"X-Iyowa-Status": r.statusCode || 502,
			"X-Iyowa-Type": r.headers["content-type"] || "application/octet-stream",
		});
		res.end(body);
	} finally {
		r.destroy();
	}
}
