import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { bestIcon, MAX_BYTES, RESERVED, readBundle, selectUpdate } from "../bundle/verify.ts";
import {
	allows,
	allowsIsolated,
	browserAllows,
	browserFeatures,
	platformFeatures,
} from "../shared/policy.ts";
import {
	type AppInfo,
	BUNDLE_ORIGIN,
	type ExampleInfo,
	type FrameConfig,
	type GuestConfig,
	type PermissionName,
	type PermissionState,
} from "../shared/types.ts";
import { bindConnection } from "./bindings.ts";
import { download, readLimited } from "./download.ts";
import { createRelay, type Decide, isPublicAddress } from "./relay.ts";
import { AppStore, type InstalledApp } from "./store.ts";

export type { AppInfo, ExampleInfo, PermissionName, PermissionState } from "../shared/types.ts";

const SDK_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DIST = join(SDK_ROOT, "dist");

type Next = () => void;
export type UiHandler = (req: IncomingMessage, res: ServerResponse, next: Next) => void;
export type UiUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => void;

export interface HostOptions {
	/** TCP port on 127.0.0.1. Use 0 for an ephemeral port. Default 4178. */
	port?: number;
	/** Where verified bundles and per-app state are stored. */
	dataDir: string;
	/** Launcher UI: a directory of static files, or a connect-style handler (e.g. Vite middleware). */
	ui?: { dir: string } | { handler: UiHandler; upgrade?: UiUpgrade };
}

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".wasm": "application/wasm",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
	".swbn": "application/octet-stream",
};

/** Runtime files served to app documents (guest) and to controlled-frame partitions. */
const GUEST_ASSETS = new Set(["guest.js", "hub.js"]);
const FRAME_ASSETS = new Set([
	"sw.js",
	"scramjet.js",
	"start.js",
	"frame-client.js",
	"frame-worker.js",
	"frame-net.js",
	"frame-error.js",
]);

function send(
	res: ServerResponse,
	status: number,
	body: string | Uint8Array = "",
	type = "text/plain; charset=utf-8",
	head = false,
) {
	res.writeHead(status, { "Content-Type": type, "Content-Length": Buffer.byteLength(body) });
	res.end(head ? undefined : body);
}
const json = (res: ServerResponse, data: unknown, status = 200) =>
	send(res, status, JSON.stringify(data), "application/json");
const script = (value: unknown, name: string) =>
	`globalThis.${name}=${JSON.stringify(value).replaceAll("<", "\\u003c")};`;
const runtimeAsset = (name: string) => readFile(join(DIST, "runtime", name));

class HttpError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

function requireSameOrigin(req: IncomingMessage) {
	if (req.headers.origin !== `http://${req.headers.host}`)
		throw new HttpError(403, "Expected a same-origin request");
}

async function readJson<T>(req: IncomingMessage, limit = 16384): Promise<T> {
	try {
		return JSON.parse((await readLimited(req, limit)).toString()) as T;
	} catch {
		throw new HttpError(400, "Expected a JSON request body");
	}
}

export async function createHost(options: HostOptions) {
	const store = new AppStore(resolve(options.dataDir));
	await store.load();
	let port = options.port ?? 4178;
	const shellOrigin = () => `http://localhost:${port}`;
	const appHost = (id: string) => `${id}.localhost:${port}`;
	const partitions = new Map<string, { app: string; partition: string; persistent: boolean }>();

	function info(app: InstalledApp): AppInfo {
		const icon = bestIcon(app.manifest, (p) => app.resources.has(p));
		return {
			id: app.id,
			origin: app.origin,
			appOrigin: `http://${appHost(app.id)}`,
			name: app.name,
			version: app.version,
			size: app.size,
			digest: app.digest,
			exchanges: app.exchanges,
			startPath: app.startPath,
			manifest: app.manifest,
			permissions: { ...app.permissions },
			installedAt: app.installedAt,
			...(icon ? { icon: `/api/apps/${app.id}/icon?v=${app.digest.slice(0, 12)}` } : {}),
		};
	}

	function guestConfig(app: InstalledApp): GuestConfig {
		return {
			id: app.id,
			manifest: app.manifest,
			shellOrigin: shellOrigin(),
			permissions: { ...app.permissions },
		};
	}

	const localGranted = (app: InstalledApp) => app.permissions["local-network"] === "granted";

	/** Direct Sockets: public destinations are open to apps declaring direct-sockets, as in Chrome.
	 * Private and loopback destinations also need direct-sockets-private and the user's grant. */
	const socketPolicy =
		(app: InstalledApp): Decide =>
		(ip) => {
			if (!allowsIsolated(app.manifest, "direct-sockets", app.id)) return false;
			if (isPublicAddress(ip)) return true;
			return allowsIsolated(app.manifest, "direct-sockets-private", app.id) && localGranted(app);
		};
	/** Controlled frames load the public web; a local-network grant also allows LAN pages. */
	const framePolicy =
		(app: InstalledApp): Decide =>
		(ip, _port, type) =>
			type === "tcp" && (isPublicAddress(ip) || localGranted(app));

	function frameConfig(label: string, app: InstalledApp): FrameConfig {
		const entry = partitions.get(label);
		return {
			parent: `http://${appHost(app.id)}`,
			shell: shellOrigin(),
			bundleOrigin: BUNDLE_ORIGIN,
			partition: entry?.partition ?? "",
			persistent: entry?.persistent ?? false,
		};
	}

	async function examples(): Promise<ExampleInfo[]> {
		const dir = join(DIST, "examples");
		const files = await readdir(dir).catch(() => [] as string[]);
		const list: ExampleInfo[] = [];
		for (const file of files.filter((f) => f.endsWith(".swbn")).sort()) {
			const bundle = readBundle(await readFile(join(dir, file)));
			list.push({
				id: bundle.id,
				file,
				name: bundle.name,
				description: bundle.manifest.description || "",
				url: `/examples/${file}`,
			});
		}
		return list;
	}

	async function api(req: IncomingMessage, res: ServerResponse, path: string) {
		const method = req.method || "GET";
		if (method === "GET" && path === "/api/apps") return json(res, [...store.apps.values()].map(info));
		if (method === "GET" && path === "/api/examples") return json(res, await examples());
		const icon = /^\/api\/apps\/([a-z2-7]+)\/icon$/.exec(path);
		if (method === "GET" && icon) {
			const app = store.apps.get(icon[1] ?? "");
			const best = app && bestIcon(app.manifest, (p) => app.resources.has(p));
			const r = best && app?.resources.get(best.path);
			if (!r) throw new HttpError(404, "No icon");
			res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
			return send(
				res,
				200,
				r.body,
				r.headers["content-type"] || best.type || "application/octet-stream",
			);
		}
		// Mutations: only the launcher page may call these (app origins are cross-origin).
		requireSameOrigin(req);
		if (req.headers["x-iyowa"] !== "1") throw new HttpError(403, "Missing SDK request header");
		if (method === "POST" && path === "/api/apps")
			return json(res, info(await store.install(await readLimited(req, MAX_BYTES))));
		if (method === "POST" && path === "/api/import") {
			const body = await readJson<{ url?: unknown; channel?: unknown; expectedId?: unknown }>(req);
			if (typeof body.url !== "string") throw new HttpError(400, "Expected a URL");
			const file = await download(body.url);
			let bytes = file.bytes,
				version: string | undefined;
			if (bytes.subarray(0, 256).toString().trimStart().startsWith("{")) {
				const choice = selectUpdate(
					JSON.parse(bytes.toString()),
					typeof body.channel === "string" ? body.channel : "default",
				);
				version = choice.version;
				bytes = (await download(new URL(choice.src, file.url).href)).bytes;
			}
			const expectedId = typeof body.expectedId === "string" ? body.expectedId : undefined;
			return json(res, info(await store.install(bytes, { version, id: expectedId })));
		}
		const one = /^\/api\/apps\/([a-z2-7]+)(\/permissions)?$/.exec(path);
		if (one && method === "DELETE" && !one[2]) {
			await store.remove(one[1] ?? "");
			for (const [label, p] of partitions) if (p.app === one[1]) partitions.delete(label);
			return json(res, {});
		}
		if (one && method === "PUT" && one[2]) {
			const body = await readJson<{ name?: PermissionName; state?: PermissionState }>(req);
			return json(
				res,
				info(
					await store.setPermission(
						one[1] ?? "",
						body.name as PermissionName,
						body.state as PermissionState,
					),
				),
			);
		}
		throw new HttpError(404, "Unknown API");
	}

	async function serveShell(req: IncomingMessage, res: ServerResponse, url: URL, head: boolean) {
		res.setHeader(
			"Content-Security-Policy",
			"frame-ancestors 'none'; object-src 'none'; base-uri 'none'",
		);
		res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
		const path = url.pathname;
		if (path.startsWith("/api/")) return api(req, res, path);
		if (req.method !== "GET" && !head) throw new HttpError(405, "Method not allowed");
		if (path === "/sdk.js")
			return send(res, 200, await readFile(join(DIST, "sdk.js")), MIME[".js"], head);
		const example = /^\/examples\/([\w.-]+\.swbn)$/.exec(path);
		if (example)
			return send(
				res,
				200,
				await readFile(join(DIST, "examples", example[1] ?? "")),
				MIME[".swbn"],
				head,
			);
		const ui = options.ui;
		if (ui && "handler" in ui) return ui.handler(req, res, () => send(res, 404, "Not found"));
		if (ui && "dir" in ui) {
			const root = resolve(ui.dir);
			const file = resolve(root, `.${decodeURIComponent(path === "/" ? "/index.html" : path)}`);
			if (!file.startsWith(root + sep)) throw new HttpError(403, "Forbidden");
			const data = await readFile(file).catch(() =>
				extname(path) ? undefined : readFile(join(root, "index.html")),
			);
			if (!data) throw new HttpError(404, "Not found");
			const type = MIME[extname(file)] || (extname(path) ? "application/octet-stream" : MIME[".html"]);
			if (path.startsWith("/assets/"))
				res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
			return send(res, 200, data, type, head);
		}
		throw new HttpError(404, "No launcher UI configured");
	}

	async function servePartition(
		req: IncomingMessage,
		res: ServerResponse,
		url: URL,
		label: string,
		head: boolean,
	) {
		const entry = partitions.get(label);
		const app = entry && store.apps.get(entry.app);
		if (!app) throw new HttpError(404, "Unknown controlled-frame partition. Reload the app.");
		if (req.method !== "GET" && !head) throw new HttpError(405, "Method not allowed");
		const path = url.pathname;
		const config = frameConfig(label, app);
		res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
		res.setHeader("Content-Security-Policy", `frame-ancestors ${config.parent} ${config.shell}`);
		if (path === `${RESERVED}frame-config.js`)
			return send(res, 200, script(config, "__iyowaFrame"), MIME[".js"], head);
		if (path === `${RESERVED}start`)
			return send(
				res,
				200,
				`<!doctype html><meta charset="utf-8"><title>Loading…</title><script src="${RESERVED}frame-config.js"></script><script src="${RESERVED}start.js"></script>`,
				MIME[".html"],
				head,
			);
		if (path === `${RESERVED}libcurl.wasm`) {
			res.setHeader("Cache-Control", "public, max-age=86400");
			return send(res, 200, await runtimeAsset("libcurl.wasm"), MIME[".wasm"], head);
		}
		const asset = path.startsWith(RESERVED) ? path.slice(RESERVED.length) : "";
		if (FRAME_ASSETS.has(asset)) {
			if (asset === "sw.js") res.setHeader("Service-Worker-Allowed", "/");
			return send(res, 200, await runtimeAsset(asset), MIME[extname(asset)], head);
		}
		if (path.startsWith(`${RESERVED}resource/`)) {
			const p = path.slice(`${RESERVED}resource`.length);
			const r = app.resources.get(p + url.search) || app.resources.get(p);
			if (!r) throw new HttpError(404, "Not in the app bundle");
			const type = r.headers["content-type"] || "application/octet-stream";
			// Absolute self-references must stay inside the proxy, which only speaks http(s).
			const body = /^text\/|javascript|json|xml/i.test(type)
				? Buffer.from(
						Buffer.from(r.body).toString().replaceAll(`${app.origin}/`, `${BUNDLE_ORIGIN}/`),
					)
				: r.body;
			return send(res, r.status, body, type, head);
		}
		throw new HttpError(404, "Not found");
	}

	async function serveApp(
		req: IncomingMessage,
		res: ServerResponse,
		url: URL,
		app: InstalledApp,
		head: boolean,
	) {
		const host = appHost(app.id),
			base = `http://${host}`,
			path = url.pathname;
		if (path === `${RESERVED}frame-session` && req.method === "POST") {
			requireSameOrigin(req);
			if (!allowsIsolated(app.manifest, "controlled-frame", app.id))
				throw new HttpError(403, "The manifest does not grant controlled-frame");
			const body = await readJson<{ partition?: unknown; persistent?: unknown }>(req, 4096);
			if (typeof body.partition !== "string" || body.partition.length > 256)
				throw new HttpError(400, "Invalid partition");
			const label = `p-${createHash("sha256").update(`${app.id}\0${body.partition}`).digest("hex").slice(0, 40)}`;
			if (!partitions.has(label) && partitions.size >= 4096)
				throw new HttpError(429, "Too many frame partitions");
			partitions.set(label, {
				app: app.id,
				partition: body.partition,
				persistent: body.persistent === true,
			});
			return json(res, { origin: `http://${label}.localhost:${port}` });
		}
		if (req.method !== "GET" && !head) throw new HttpError(405, "Method not allowed");
		if (path === `${RESERVED}config.js`)
			return send(res, 200, script(guestConfig(app), "__iyowaConfig"), MIME[".js"], head);
		if (path.startsWith(RESERVED) && GUEST_ASSETS.has(path.slice(RESERVED.length)))
			return send(res, 200, await runtimeAsset(path.slice(RESERVED.length)), MIME[".js"], head);

		const r = app.resources.get(path + url.search) || app.resources.get(path);
		if (!r) throw new HttpError(404, "Not in the signed bundle");
		for (const k of ["content-language", "last-modified", "content-disposition"])
			if (r.headers[k]) res.setHeader(k, r.headers[k]);
		res.setHeader("Permissions-Policy", [
			browserFeatures
				.filter((f) => !platformFeatures.has(f) || allows(app.manifest, f, app.id))
				.map((f) => `${f}=${browserAllows(app.manifest, f, app.id) ? "(self)" : "()"}`)
				.join(", "),
			...(r.headers["permissions-policy"] ? [r.headers["permissions-policy"]] : []),
		]);
		// The IWA baseline CSP, adapted to the runtime's real origins. A bundled CSP still applies on top.
		const frames = allows(app.manifest, "controlled-frame", app.id) ? ` http://*.localhost:${port}` : "";
		res.setHeader("Content-Security-Policy", [
			`default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; img-src 'self' https: data: blob:; media-src 'self' https: data: blob:; font-src 'self' data: blob:; connect-src 'self' https: wss: ws://${host}; frame-src 'self' https: blob: data:${frames}; worker-src 'self' blob:; frame-ancestors 'self' ${shellOrigin()}`,
			...(r.headers["content-security-policy"]
				? [
						r.headers["content-security-policy"]
							.split(";")
							.map((d) => {
								if (/^\s*frame-ancestors\s+'self'\s*$/i.test(d))
									return `${d.trim()} ${shellOrigin()}`;
								if (/^\s*frame-src\s+/i.test(d) && frames) return `${d.trim()}${frames}`;
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
		} else if (/javascript|text\/css|manifest\+json/i.test(type)) {
			const dest = String(req.headers["sec-fetch-dest"]);
			const prefix = ["worker", "sharedworker", "serviceworker"].includes(dest)
				? `${script(guestConfig(app), "__iyowaConfig")}\n${await runtimeAsset("worker.js")}\n`
				: "";
			data = Buffer.from(prefix + data.toString().replaceAll(app.origin, base));
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
			const m = /^bytes=(\d*)-(\d*)$/.exec(range);
			const a = m?.[1] ? Number(m[1]) : Math.max(0, data.length - Number(m?.[2]));
			const b = m?.[1] && m[2] ? Math.min(Number(m[2]), data.length - 1) : data.length - 1;
			if (!m || (!m[1] && !m[2]) || a > b || a >= data.length) {
				res.setHeader("Content-Range", `bytes */${data.length}`);
				return send(res, 416);
			}
			res.setHeader("Content-Range", `bytes ${a}-${b}/${data.length}`);
			return send(res, 206, data.subarray(a, b + 1), type, head);
		}
		send(res, r.status, data, type, head);
	}

	async function serve(req: IncomingMessage, res: ServerResponse) {
		const host = req.headers.host || "";
		const url = new URL(req.url || "/", `http://${host}`);
		const head = req.method === "HEAD";
		if (url.host !== host) throw new HttpError(400, "Bad request");
		for (const [k, v] of Object.entries({
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
			"Referrer-Policy": "no-referrer",
			"Cross-Origin-Opener-Policy": "same-origin",
			"Cross-Origin-Embedder-Policy": "credentialless",
			"Origin-Agent-Cluster": "?1",
		}))
			res.setHeader(k, v);
		if (host === `127.0.0.1:${port}` || host === `[::1]:${port}`) {
			res.writeHead(307, { Location: `${shellOrigin()}${url.pathname}${url.search}` });
			res.end();
			return;
		}
		if (host === `localhost:${port}`) return serveShell(req, res, url, head);
		const label = host.endsWith(`.localhost:${port}`) ? host.slice(0, host.indexOf(".")) : "";
		if (label.startsWith("p-")) return servePartition(req, res, url, label, head);
		const app = store.apps.get(label);
		if (app && host === appHost(app.id)) return serveApp(req, res, url, app, head);
		throw new HttpError(404, "Unknown Iyowa host");
	}

	const http = createServer((req, res) => {
		serve(req, res).catch((e: unknown) => {
			if (res.headersSent) return void res.destroy();
			const status =
				e instanceof HttpError
					? e.status
					: (e as NodeJS.ErrnoException)?.code === "ENOENT"
						? 404
						: 400;
			send(res, status, e instanceof Error ? e.message : "Request failed");
		});
	});

	const relay = createRelay();
	http.on("upgrade", (req, socket, head) => {
		const host = req.headers.host || "";
		const origin = `http://${host}`;
		const label = host.endsWith(`.localhost:${port}`) ? host.slice(0, host.indexOf(".")) : "";
		const reject = () => socket.destroy();
		if (req.headers.origin !== origin) return reject();
		// The launcher's own WebSockets (e.g. Vite HMR in development).
		if (host === `localhost:${port}`) {
			const ui = options.ui;
			return ui && "upgrade" in ui && ui.upgrade ? ui.upgrade(req, socket, head) : reject();
		}
		if (label.startsWith("p-")) {
			const app = store.apps.get(partitions.get(label)?.app ?? "");
			if (!app || req.url !== `${RESERVED}net/`) return reject();
			return relay.handle(req, socket, head, { decide: framePolicy(app), ack: false });
		}
		const app = store.apps.get(label);
		if (!app || host !== appHost(app.id) || !allowsIsolated(app.manifest, "direct-sockets", app.id))
			return reject();
		if (req.url === `${RESERVED}wisp/`)
			return relay.handle(req, socket, head, { decide: socketPolicy(app), ack: true });
		if (req.url === `${RESERVED}bind/`) {
			if (!allowsIsolated(app.manifest, "direct-sockets-private", app.id) || !localGranted(app))
				return reject();
			return relay.upgrade(req, socket, head, (ws) => bindConnection(ws, socketPolicy(app)));
		}
		reject();
	});

	await new Promise<void>((ok, no) => {
		http.once("error", no);
		http.listen(port, "127.0.0.1", ok);
	});
	const address = http.address();
	if (typeof address === "object" && address) port = address.port;

	return {
		get origin() {
			return shellOrigin();
		},
		get port() {
			return port;
		},
		list: () => [...store.apps.values()].map(info),
		install: async (bytes: Uint8Array) => info(await store.install(bytes)),
		setPermission: async (id: string, name: PermissionName, state: PermissionState) =>
			info(await store.setPermission(id, name, state)),
		async close() {
			relay.close();
			http.closeAllConnections();
			await new Promise<void>((ok) => http.close(() => ok()));
		},
	};
}

export type IyowaHost = Awaited<ReturnType<typeof createHost>>;
