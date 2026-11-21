import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ipaddr from "ipaddr.js";
import type { ViteDevServer } from "vite";
import { compareVersions, MAX_BYTES, RESERVED, readBundle, selectUpdate } from "../runtime/bundle.ts";
import { allows, browserAllows, browserFeatures } from "../runtime/policy.ts";
import type { AppInfo, Grant, GuestConfig } from "../runtime/types.ts";
import { download, readLimited } from "./download.ts";
import { serveFrameSource } from "./frame-source.ts";
import { attachRelay } from "./relay.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
type App = ReturnType<typeof readBundle>;
export interface HostOptions {
	port?: number;
	dataDir?: string;
	/** Prebuilt shell to serve on the launcher origin (defaults to Vite's dist/ui). */
	uiDir?: string;
	dev?: boolean;
	grants?: Grant[];
	bindings?: Grant[];
	managedOrigins?: string[];
}
const mime: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript",
	".ts": "text/javascript",
	".css": "text/css",
	".json": "application/json",
	".wasm": "application/wasm",
	".svg": "image/svg+xml",
	".swbn": "application/octet-stream",
};
function output(
	res: ServerResponse,
	status: number,
	body: string | Uint8Array = "",
	type = "text/plain; charset=utf-8",
	head = false,
) {
	res.writeHead(status, { "Content-Type": type, "Content-Length": Buffer.byteLength(body) });
	res.end(head ? undefined : body);
}
function json(res: ServerResponse, data: unknown) {
	output(res, 200, JSON.stringify(data), "application/json");
}
function sameOrigin(req: IncomingMessage) {
	if (req.headers.origin !== `http://${req.headers.host}`) throw Error("Expected same-origin request");
}
function safeJS(value: unknown) {
	return JSON.stringify(value).replaceAll("<", "\\u003c");
}
function built(path: string) {
	return readFile(join(ROOT, "dist", path));
}
const frameAssets = new Set(["scramjet.js", "proxy-sw.js", "proxy-client.js", "proxy-start.js"]);
const guestAssets = new Set(["guest.js", "hub.js"]);

export async function createHost(options: HostOptions = {}) {
	const apps = new Map<string, App>(),
		frames = new Map<string, { app: App; virtual: string; parent: string }>();
	const dataDir = resolve(options.dataDir || join(ROOT, ".iyowa"));
	const uiDir = resolve(options.uiDir || join(ROOT, "dist/ui"));
	await mkdir(dataDir, { recursive: true, mode: 0o700 });
	for (const file of await readdir(dataDir))
		if (/^[a-z2-7]+\.swbn$/.test(file)) {
			const app = readBundle(await readFile(join(dataDir, file)));
			if (`${app.id}.swbn` !== file) throw Error("Stored bundle ID mismatch");
			apps.set(app.id, app);
		}
	let port = options.port ?? 4178,
		vite: ViteDevServer | undefined;
	const shell = () => `http://localhost:${port}`,
		appHost = (id: string) => `${id}.localhost:${port}`;
	function info(app: App): AppInfo {
		const { resources: _, ...rest } = app;
		return { ...rest, appOrigin: `http://${appHost(app.id)}` };
	}
	function grants(app: App) {
		return allows(app.manifest, "direct-sockets", app.id) &&
			allows(app.manifest, "cross-origin-isolated", app.id)
			? (options.grants || []).filter(
					(g) =>
						g.id === app.id &&
						ipaddr.isValid(g.address) &&
						(ipaddr.process(g.address).range() === "unicast" ||
							allows(app.manifest, "direct-sockets-private", app.id)),
				)
			: [];
	}
	function config(app: App): GuestConfig {
		return {
			id: app.id,
			manifest: app.manifest,
			shellOrigin: shell(),
			grants: grants(app),
			bindings: (options.bindings || []).filter(
				(g) =>
					g.id === app.id &&
					["127.0.0.1", "::1"].includes(g.address) &&
					Number.isInteger(g.port) &&
					(g.port === 0 || (g.port >= 1024 && g.port <= 65535)) &&
					allows(app.manifest, "cross-origin-isolated", app.id) &&
					allows(app.manifest, "direct-sockets", app.id) &&
					allows(app.manifest, "direct-sockets-private", app.id),
			),
			managedOrigins: options.managedOrigins || [],
		};
	}
	let serial = Promise.resolve();
	function mutation<T>(task: () => Promise<T>) {
		const next = serial.then(task);
		serial = next.then(
			() => {},
			() => {},
		);
		return next;
	}
	function install(bytes: Uint8Array, expected?: string, id?: string) {
		return mutation(async () => {
			const app = readBundle(bytes);
			if (expected && expected !== app.version)
				throw Error("Update manifest version does not match signed application");
			if (id && id !== app.id) throw Error("Unexpected signing identity");
			const prev = apps.get(app.id);
			if (prev) {
				const cmp = compareVersions(app.version, prev.version);
				if (cmp < 0 || (cmp === 0 && prev.digest !== app.digest))
					throw Error("Refusing downgrade or conflicting same-version bundle");
			}
			const tmp = join(dataDir, `${randomUUID()}.tmp`);
			try {
				await writeFile(tmp, bytes, { mode: 0o600 });
				await rename(tmp, join(dataDir, `${app.id}.swbn`));
			} finally {
				await rm(tmp, { force: true });
			}
			apps.set(app.id, app);
			for (const f of frames.values()) if (f.app.id === app.id) f.app = app;
			return info(app);
		});
	}
	async function serve(req: IncomingMessage, res: ServerResponse) {
		const host = req.headers.host || "",
			base = `http://${host}`,
			url = new URL(req.url || "/", base),
			path = url.pathname,
			head = req.method === "HEAD";
		if (url.origin !== base) return output(res, 400);
		for (const [k, v] of Object.entries({
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
			"Referrer-Policy": "no-referrer",
			"Cross-Origin-Opener-Policy": "same-origin",
			"Cross-Origin-Embedder-Policy": "credentialless",
			"Origin-Agent-Cluster": "?1",
		}))
			res.setHeader(k, v);
		if (host === `127.0.0.1:${port}`) {
			res.writeHead(307, { Location: `${shell()}/` });
			res.end();
			return;
		}
		if (host === `localhost:${port}`) {
			res.setHeader(
				"Content-Security-Policy",
				"frame-ancestors 'none'; object-src 'none'; base-uri 'none'",
			);
			res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
			if (path.startsWith("/api/")) {
				if (req.method === "GET" && path === "/api/apps")
					return json(res, [...apps.values()].map(info));
				sameOrigin(req);
				if (req.headers["x-iyowa"] !== "1") return output(res, 403, "Missing SDK request header");
				if (req.method === "POST" && path === "/api/apps")
					return json(res, await install(await readLimited(req, MAX_BYTES)));
				if (req.method === "POST" && path === "/api/import") {
					const {
						url: source,
						channel,
						expectedId,
					} = JSON.parse((await readLimited(req, 16384)).toString());
					const file = await download(source);
					let expected: string | undefined,
						bytes = file.bytes;
					if (bytes.subarray(0, 256).toString().trimStart().startsWith("{")) {
						const choice = selectUpdate(JSON.parse(bytes.toString()), channel);
						expected = choice.version;
						bytes = (await download(new URL(choice.src, file.url).href)).bytes;
					}
					return json(res, await install(bytes, expected, expectedId));
				}
				if (req.method === "DELETE" && /^\/api\/apps\/[a-z2-7]+$/.test(path)) {
					const id = path.split("/").pop() || "";
					await mutation(async () => {
						await rm(join(dataDir, `${id}.swbn`), { force: true });
						apps.delete(id);
						for (const [k, f] of frames) if (f.app.id === id) frames.delete(k);
					});
					return json(res, {});
				}
				return output(res, 404);
			}
			if (req.method !== "GET" && !head) return output(res, 405);
			if (path === "/sdk.js" || path === "/example.swbn")
				return output(res, 200, await built(path.slice(1)), mime[extname(path)], head);
			if (vite) {
				vite.middlewares(req, res);
				return;
			}
			if (path === "/" || /^\/(?:[\w-]+\/)*[\w-][\w.-]*$/.test(path)) {
				try {
					return output(
						res,
						200,
						await readFile(join(uiDir, path === "/" ? "index.html" : path.slice(1))),
						mime[extname(path)] || (path === "/" ? "text/html" : "application/octet-stream"),
						head,
					);
				} catch {
					return output(res, 404);
				}
			}
			return output(res, 404);
		}
		const frame = frames.get(host);
		if (frame) {
			if (req.method !== "GET" && !head) return output(res, 405);
			res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
			res.setHeader("Content-Security-Policy", `frame-ancestors ${frame.parent} ${shell()}`);
			const publicSource =
				frame.virtual !== "https://bundle.invalid" &&
				!options.managedOrigins?.includes(frame.virtual);
			if (path === `${RESERVED}upstream` && publicSource) {
				if (req.headers["x-iyowa-source"] !== "1") return output(res, 403);
				return serveFrameSource(frame.virtual, url.searchParams.get("path") || "/", base, res);
			}
			if (path === `${RESERVED}frame-error.js`)
				return output(
					res,
					200,
					`const redirect=document.querySelector('meta[name="iyowa-redirect"]')?.content;parent.postMessage(redirect?{iyowa:'redirect',url:redirect}:{iyowa:'event',name:'loadabort',fields:{reason:document.querySelector('p')?.textContent}},globalThis.__iyowaFrame.parent);`,
					"text/javascript",
				);
			if (path.startsWith(RESERVED) && frameAssets.has(path.slice(RESERVED.length))) {
				if (path.endsWith("proxy-sw.js")) res.setHeader("Service-Worker-Allowed", "/");
				return output(
					res,
					200,
					await built(`runtime/${path.slice(RESERVED.length)}`),
					"text/javascript",
				);
			}
			if (path === `${RESERVED}frame-config.js`)
				return output(
					res,
					200,
					`globalThis.__iyowaFrame=${safeJS({ virtual: frame.virtual, parent: frame.parent, publicSource })};`,
					"text/javascript",
				);
			if (path === `${RESERVED}start`)
				return output(
					res,
					200,
					`<!doctype html><meta charset=utf-8><script src="${RESERVED}frame-config.js"></script><script src="${RESERVED}proxy-start.js"></script>`,
					"text/html",
				);
			if (path.startsWith(`${RESERVED}resource/`) && frame.virtual === "https://bundle.invalid") {
				const p = path.slice(`${RESERVED}resource`.length);
				const r = frame.app.resources.get(p + url.search) || frame.app.resources.get(p);
				return r ? output(res, r.status, r.body, r.headers["content-type"], head) : output(res, 404);
			}
			return output(res, 404);
		}
		const app = apps.get(host.split(".")[0]);
		if (!app || host !== appHost(app.id)) return output(res, 404, "Unknown Iyowa host");
		const cfg = config(app);
		if (path === `${RESERVED}frame-session` && req.method === "POST") {
			sameOrigin(req);
			if (
				!allows(app.manifest, "controlled-frame", app.id) ||
				!allows(app.manifest, "cross-origin-isolated", app.id)
			)
				return output(res, 403);
			const { virtual, partition } = JSON.parse((await readLimited(req, 4096)).toString());
			if (
				typeof virtual !== "string" ||
				typeof partition !== "string" ||
				new URL(virtual).origin !== virtual
			)
				return output(res, 400, "Invalid frame origin or partition");
			if (new URL(virtual).protocol !== "https:" && !cfg.managedOrigins.includes(virtual))
				return output(res, 403);
			const label =
					"f-" +
					createHash("sha256")
						.update(JSON.stringify([app.id, virtual, partition]))
						.digest("hex")
						.slice(0, 48),
				fh = appHost(label);
			if (!frames.has(fh) && frames.size >= 4096) throw Error("Frame session limit reached");
			frames.set(fh, { app, virtual, parent: base });
			return json(res, { origin: `http://${fh}` });
		}
		if (req.method !== "GET" && !head) return output(res, 405);
		if (path === `${RESERVED}config.js`)
			return output(res, 200, `globalThis.__iyowaConfig=${safeJS(cfg)};`, "text/javascript");
		if (path.startsWith(RESERVED) && guestAssets.has(path.slice(RESERVED.length)))
			return output(res, 200, await built(`runtime/${path.slice(RESERVED.length)}`), "text/javascript");
		const r = app.resources.get(path + url.search) || app.resources.get(path);
		if (!r) return output(res, 404, "Not in signed bundle");
		for (const k of [
			"content-language",
			"permissions-policy",
			"content-security-policy",
			"last-modified",
			"content-disposition",
		])
			if (r.headers[k]) res.setHeader(k, r.headers[k]);
		const policy = browserFeatures
			.map((f) => `${f}=${browserAllows(app.manifest, f, app.id) ? "(self)" : "()"}`)
			.join(", ");
		res.setHeader("Permissions-Policy", [
			policy,
			...(r.headers["permissions-policy"] ? [r.headers["permissions-policy"]] : []),
		]);
		res.setHeader("Content-Security-Policy", [
			`default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; img-src 'self' https: data: blob:; media-src 'self' https: data: blob:; font-src 'self' data: blob:; connect-src 'self' https: wss: ws://${host}; frame-src 'self' https: http://*.localhost:${port} blob: data:; worker-src 'self' blob:; frame-ancestors 'self' ${shell()}`,
			...(r.headers["content-security-policy"]
				? [
						r.headers["content-security-policy"]
							.split(";")
							.map((d) => {
								// The verified package is being launched in the shell's window. Keep all other ancestors out.
								if (/^\s*frame-ancestors\s+'self'\s*$/i.test(d))
									return `${d.trim()} ${shell()}`;
								if (
									/^\s*frame-src\s+/i.test(d) &&
									allows(app.manifest, "controlled-frame", app.id)
								)
									return `${d.trim()} http://*.localhost:${port}`;
								return d;
							})
							.join(";"),
					]
				: []),
		]);
		res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
		const type = r.headers["content-type"] || "application/octet-stream";
		let data = Buffer.from(r.body);
		if (/^text\/html\b/i.test(type)) {
			const html = data.toString().replaceAll(app.origin, base);
			const inject = `<script src="${RESERVED}config.js"></script><script src="${RESERVED}guest.js"></script>`;
			const prolog = /^(?:\s|<!--[\s\S]*?-->)*(?:<!doctype\s+html[^>]*>)?/i.exec(html)?.[0] || "";
			data = Buffer.from(prolog + inject + html.slice(prolog.length));
		} else if (/(?:javascript|text\/css|manifest\+json)/i.test(type)) {
			const dest = req.headers["sec-fetch-dest"];
			const prefix = ["worker", "sharedworker", "serviceworker"].includes(String(dest))
				? `globalThis.__iyowaConfig=${safeJS(cfg)};\n${await built("runtime/worker.js")}\n`
				: "";
			const text = data.toString().replaceAll(app.origin, base);
			data = Buffer.from(prefix + text);
		}
		if (r.headers.location) {
			const dest = new URL(r.headers.location, app.origin + path);
			if (dest.protocol === "isolated-app:" && dest.host === app.id)
				res.setHeader("Location", base + dest.pathname + dest.search + dest.hash);
			else if (dest.protocol === "https:") res.setHeader("Location", dest.href);
		}
		res.setHeader("Accept-Ranges", "bytes");
		const range = req.headers.range;
		if (range && r.status === 200) {
			const m = /^bytes=(\d*)-(\d*)$/.exec(range),
				a = m?.[1] ? Number(m[1]) : Math.max(0, data.length - Number(m?.[2])),
				b = m?.[1] && m[2] ? Math.min(Number(m[2]), data.length - 1) : data.length - 1;
			if (!m || (!m[1] && !m[2]) || a > b || a >= data.length) {
				res.setHeader("Content-Range", `bytes */${data.length}`);
				return output(res, 416);
			}
			res.setHeader("Content-Range", `bytes ${a}-${b}/${data.length}`);
			return output(res, 206, data.subarray(a, b + 1), type, head);
		}
		output(res, r.status, data, type, head);
	}
	const http = createServer((req, res) => {
		void serve(req, res).catch((e) => {
			if (!res.headersSent) output(res, 400, e instanceof Error ? e.message : "Request failed");
			else res.destroy();
		});
	});
	const closeRelay = attachRelay(
		http,
		(host) => {
			const app = apps.get(host.split(".")[0]);
			return app && host === appHost(app.id) ? grants(app) : [];
		},
		(host) => {
			const app = apps.get(host.split(".")[0]);
			return app && host === appHost(app.id) ? config(app).bindings : [];
		},
	);
	if (options.dev) {
		const { createServer } = await import("vite");
		vite = await createServer({
			root: ROOT,
			server: {
				middlewareMode: true,
				hmr: false,
				fs: {
					strict: true,
					deny: [
						`${dataDir}/**`,
						"**/.iyowa/**",
						"**/.cache/**",
						"**/.git/**",
						"**/*.pem",
						"**/.env*",
					],
				},
			},
		});
	}
	await new Promise<void>((ok, no) => {
		http.once("error", no);
		http.listen(port, "127.0.0.1", ok);
	});
	const addr = http.address();
	if (typeof addr === "object" && addr) port = addr.port;
	return {
		origin: shell(),
		install,
		list: () => [...apps.values()].map(info),
		async close() {
			closeRelay();
			await vite?.close();
			http.closeAllConnections();
			await new Promise<void>((ok) => http.close(() => ok()));
		},
	};
}
