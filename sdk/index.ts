import { allows, browserFeatures } from "../runtime/policy.ts";
import type { AppInfo } from "../runtime/types.ts";

export type { AppInfo, Manifest } from "../runtime/types.ts";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
	const r = await fetch(`/api/${path}`, { ...init, headers: { "X-Iyowa": "1", ...init?.headers } });
	if (!r.ok) throw Error((await r.text()) || `HTTP ${r.status}`);
	return r.json();
}
export class IwaRuntime {
	list() {
		return api<AppInfo[]>("apps");
	}
	install(file: Blob | ArrayBuffer) {
		return api<AppInfo>("apps", { method: "POST", body: file });
	}
	installURL(url: string, options: { channel?: string; expectedId?: string } = {}) {
		return api<AppInfo>("import", { method: "POST", body: JSON.stringify({ url, ...options }) });
	}
	update(app: AppInfo, channel = "default") {
		if (!app.manifest.update_manifest_url) throw Error("No update manifest declared");
		return this.installURL(app.manifest.update_manifest_url, { expectedId: app.id, channel });
	}
	remove(id: string) {
		return api(`apps/${encodeURIComponent(id)}`, { method: "DELETE" });
	}
	launch(app: AppInfo, container: Element, path = app.startPath) {
		return new IwaSession(app, container, path);
	}
}
export class IwaSession extends EventTarget {
	readonly app: AppInfo;
	readonly frame: HTMLIFrameElement;
	readonly ready: Promise<void>;
	#abort = new AbortController();
	#current = "";
	constructor(app: AppInfo, container: Element, path: string) {
		super();
		this.app = app;
		const frame = document.createElement("iframe");
		this.frame = frame;
		frame.title = app.name;
		frame.dataset.iyowaApp = app.id;
		frame.setAttribute(
			"sandbox",
			"allow-same-origin allow-scripts allow-downloads allow-forms allow-modals allow-pointer-lock allow-presentation allow-popups",
		);
		frame.allow = browserFeatures
			.filter((f) => allows(app.manifest, f, app.id))
			.map((f) => `${f} ${app.appOrigin}`)
			.join("; ");
		const pending = Promise.withResolvers<void>();
		this.ready = pending.promise;
		this.ready.catch(() => {});
		const timer = setTimeout(
			() => pending.reject(Error("Application did not acknowledge startup")),
			20000,
		);
		this.#abort.signal.addEventListener("abort", () => {
			clearTimeout(timer);
			pending.reject(new DOMException("Session stopped", "AbortError"));
		});
		addEventListener(
			"message",
			(e) => {
				if (
					e.origin !== app.appOrigin ||
					e.source !== frame.contentWindow ||
					e.data?.iyowa !== "runtime"
				)
					return;
				if (e.data.type === "ready") {
					if (typeof e.data.detail?.url === "string") this.#current = e.data.detail.url;
					clearTimeout(timer);
					pending.resolve();
				}
				this.dispatchEvent(new CustomEvent(e.data.type, { detail: e.data.detail }));
			},
			{ signal: this.#abort.signal },
		);
		this.navigate(path);
		container.append(frame);
	}
	navigate(path: string) {
		const u = new URL(path.replace(`${this.app.origin}/`, `${this.app.appOrigin}/`), this.app.appOrigin);
		if (u.origin !== this.app.appOrigin || u.pathname.startsWith("/.iyowa/"))
			throw Error("Not an app URL");
		this.frame.src = u.href;
		this.#current = u.href;
	}
	openProtocol(input: string) {
		const u = new URL(input),
			h = this.app.manifest.protocol_handlers?.find((x) => x.protocol === u.protocol.slice(0, -1));
		if (!h) throw Error("No registered protocol handler");
		this.navigate(h.url.replace("%s", encodeURIComponent(u.href)));
	}
	deliverLaunch(targetURL: string, files: FileSystemFileHandle[] = []) {
		this.frame.contentWindow?.postMessage({ iyowa: "launch", targetURL, files }, this.app.appOrigin);
	}
	reload() {
		this.navigate(this.#current);
	}
	stop() {
		this.#abort.abort();
		this.frame.remove();
		this.dispatchEvent(new Event("stop"));
	}
}
