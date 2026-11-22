import type { SocketEvent } from "../runtime/bridge.ts";
import { browserAllows, browserFeatures, runtimeFeatures } from "../shared/policy.ts";
import type { AppInfo, ExampleInfo, PermissionName, PermissionState } from "../shared/types.ts";

export type { SocketEvent } from "../runtime/bridge.ts";
export { allows, allowsIsolated, runtimeFeatures } from "../shared/policy.ts";
export type {
	AppInfo,
	ExampleInfo,
	Manifest,
	ManifestIcon,
	PermissionName,
	PermissionState,
	Permissions,
} from "../shared/types.ts";

export interface ConsoleEntry {
	/** Increasing per session; stable across console trimming. */
	id: number;
	level: "log" | "info" | "warn" | "error" | "debug";
	message: string;
	time: number;
}

/** Fired on an IwaSession when the app needs a decision from the user. Call respond() once. */
export class PermissionRequestEvent extends Event {
	readonly name: PermissionName;
	readonly reason: string;
	readonly #respond: (state: "granted" | "denied") => void;
	#done = false;
	constructor(name: PermissionName, reason: string, respond: (state: "granted" | "denied") => void) {
		super("permissionrequest", { cancelable: true });
		this.name = name;
		this.reason = reason;
		this.#respond = respond;
	}
	respond(state: "granted" | "denied") {
		if (this.#done) return;
		this.#done = true;
		this.#respond(state);
	}
	allow() {
		this.respond("granted");
	}
	deny() {
		this.respond("denied");
	}
}

export interface RuntimeOptions {
	/** Origin of the Iyowa host. Defaults to the current page (the launcher origin). */
	host?: string;
}

/** Client for an Iyowa host: library management and app sessions. */
export class IwaRuntime extends EventTarget {
	readonly host: string;
	readonly #sessions = new Map<string, IwaSession>();

	constructor(options: RuntimeOptions = {}) {
		super();
		this.host = options.host ?? location.origin;
		addEventListener("message", (e) => {
			if (e.data?.iyowa !== "guest") return;
			this.#sessions.get(e.origin)?.receive(e);
		});
	}

	async #api<T>(path: string, init: RequestInit = {}): Promise<T> {
		const r = await fetch(`${this.host}/api/${path}`, {
			...init,
			headers: {
				"X-Iyowa": "1",
				...(init.body && typeof init.body === "string" ? { "Content-Type": "application/json" } : {}),
				...init.headers,
			},
		});
		if (!r.ok) throw new Error((await r.text()) || `HTTP ${r.status}`);
		return r.json() as Promise<T>;
	}
	#changed(app?: AppInfo) {
		if (app) for (const s of this.#sessions.values()) if (s.app.id === app.id) s.update(app);
		this.dispatchEvent(new CustomEvent("change", { detail: app }));
	}

	list(): Promise<AppInfo[]> {
		return this.#api("apps");
	}
	examples(): Promise<ExampleInfo[]> {
		return this.#api("examples");
	}
	/** Verify and install a signed web bundle (.swbn). Reinstalling may only move to a newer version. */
	async install(bundle: Blob | ArrayBuffer | Uint8Array): Promise<AppInfo> {
		const app = await this.#api<AppInfo>("apps", { method: "POST", body: bundle as BodyInit });
		this.#changed(app);
		return app;
	}
	/** Install from a public HTTPS .swbn URL or an IWA update manifest (picks the channel's newest version). */
	async installURL(url: string, options: { channel?: string; expectedId?: string } = {}): Promise<AppInfo> {
		const app = await this.#api<AppInfo>("import", {
			method: "POST",
			body: JSON.stringify({ url, ...options }),
		});
		this.#changed(app);
		return app;
	}
	/** Check the app's update_manifest_url and install a newer version signed by the same key. */
	update(app: AppInfo, channel = "default"): Promise<AppInfo> {
		if (!app.manifest.update_manifest_url)
			return Promise.reject(new Error("This app has no update manifest"));
		const url = new URL(app.manifest.update_manifest_url, `${app.origin}/`);
		return this.installURL(url.href, { expectedId: app.id, channel });
	}
	async remove(id: string): Promise<void> {
		for (const s of this.#sessions.values()) if (s.app.id === id) s.stop();
		await this.#api(`apps/${encodeURIComponent(id)}`, { method: "DELETE" });
		this.#changed();
	}
	async setPermission(id: string, name: PermissionName, state: PermissionState): Promise<AppInfo> {
		const app = await this.#api<AppInfo>(`apps/${encodeURIComponent(id)}/permissions`, {
			method: "PUT",
			body: JSON.stringify({ name, state }),
		});
		this.#changed(app);
		return app;
	}
	/** Absolute URL of the app's icon, if it has one. */
	iconURL(app: AppInfo): string | undefined {
		return app.icon ? new URL(app.icon, this.host).href : undefined;
	}

	sessions(): IwaSession[] {
		return [...this.#sessions.values()];
	}
	session(id: string): IwaSession | undefined {
		return this.sessions().find((s) => s.app.id === id);
	}
	/** Start the app in a new frame inside `container`. A running session of the same app is stopped first. */
	launch(app: AppInfo, container: Element, options: { path?: string } = {}): IwaSession {
		this.#sessions.get(app.appOrigin)?.stop();
		const session = new IwaSession(this, app, container, options.path ?? app.startPath);
		this.#sessions.set(app.appOrigin, session);
		session.addEventListener("stop", () => {
			if (this.#sessions.get(app.appOrigin) === session) this.#sessions.delete(app.appOrigin);
			this.dispatchEvent(new CustomEvent("sessions"));
		});
		this.dispatchEvent(new CustomEvent("sessions"));
		return session;
	}
}

/** A running app: its frame, live state and developer-facing events. */
export class IwaSession extends EventTarget {
	app: AppInfo;
	readonly frame: HTMLIFrameElement;
	readonly ready: Promise<void>;
	readonly console: ConsoleEntry[] = [];
	readonly sockets = new Map<string, SocketEvent>();
	url = "";
	title = "";
	stopped = false;
	readonly #runtime: IwaRuntime;
	readonly #ready = Promise.withResolvers<void>();
	readonly #asking = new Map<PermissionName, Promise<PermissionState>>();
	#consoleSeq = 0;

	constructor(runtime: IwaRuntime, app: AppInfo, container: Element, path: string) {
		super();
		this.#runtime = runtime;
		this.app = app;
		this.title = app.name;
		this.ready = this.#ready.promise;
		this.ready.catch(() => {});
		const frame = document.createElement("iframe");
		this.frame = frame;
		frame.title = app.name;
		frame.dataset.iyowaApp = app.id;
		frame.setAttribute(
			"sandbox",
			"allow-same-origin allow-scripts allow-forms allow-modals allow-downloads allow-pointer-lock allow-presentation allow-popups allow-popups-to-escape-sandbox",
		);
		frame.allow = browserFeatures
			.filter((f) => browserAllows(app.manifest, f, app.id))
			.map((f) => `${f} ${app.appOrigin}`)
			.join("; ");
		const timer = setTimeout(
			() => this.#ready.reject(new Error(`${app.name} did not start within 30 seconds`)),
			30000,
		);
		this.ready.then(
			() => clearTimeout(timer),
			() => clearTimeout(timer),
		);
		this.navigate(path);
		container.append(frame);
	}

	/** Called by the runtime with messages from this app's documents. */
	receive(e: MessageEvent) {
		const m = e.data as { type: string; id?: string; detail: Record<string, unknown> };
		const source = e.source as Window | null;
		switch (m.type) {
			case "ready":
				if (source !== this.frame.contentWindow) return;
				this.url = String(m.detail.url);
				this.title = String(m.detail.title || this.app.name);
				this.#ready.resolve();
				break;
			case "title":
				if (source !== this.frame.contentWindow) return;
				this.title = String(m.detail.title || this.app.name);
				break;
			case "console":
			case "error": {
				const entry: ConsoleEntry = {
					id: ++this.#consoleSeq,
					level:
						m.type === "error" ? "error" : ((m.detail.level as ConsoleEntry["level"]) ?? "log"),
					message: String(m.detail.message),
					time: Date.now(),
				};
				this.console.push(entry);
				if (this.console.length > 2000) this.console.splice(0, this.console.length - 2000);
				this.dispatchEvent(new CustomEvent("console", { detail: entry }));
				return;
			}
			case "socket": {
				const socket = m.detail as unknown as SocketEvent;
				this.sockets.set(socket.id, socket);
				if (this.sockets.size > 500)
					for (const [id, s] of this.sockets)
						if (s.state === "closed" || s.state === "failed") {
							this.sockets.delete(id);
							if (this.sockets.size <= 400) break;
						}
				this.dispatchEvent(new CustomEvent("socket", { detail: socket }));
				return;
			}
			case "permission":
				void this.#permission(m.detail.name as PermissionName, String(m.detail.reason)).then(
					(value) =>
						source?.postMessage(
							{ iyowa: "host", type: "reply", id: m.id, value },
							this.app.appOrigin,
						),
				);
				return;
			default:
				return;
		}
		this.dispatchEvent(new CustomEvent(m.type, { detail: m.detail }));
	}

	#permission(name: PermissionName, reason: string): Promise<PermissionState> {
		const known = this.app.permissions[name];
		if (known !== "prompt") return Promise.resolve(known);
		let pending = this.#asking.get(name);
		if (!pending) {
			pending = new Promise<"granted" | "denied">((respond) => {
				const event = new PermissionRequestEvent(name, reason, respond);
				// Without a launcher to ask, the safe default is to refuse.
				if (this.dispatchEvent(event) && !this.#hasListener) event.deny();
			}).then(async (state) => {
				try {
					await this.#runtime.setPermission(this.app.id, name, state);
				} catch {
					/* Still answer the app; the host enforces its own state. */
				}
				return state;
			});
			pending.finally(() => this.#asking.delete(name));
			this.#asking.set(name, pending);
		}
		return pending;
	}
	#listeners = 0;
	get #hasListener() {
		return this.#listeners > 0;
	}
	override addEventListener(
		type: string,
		listener: EventListenerOrEventListenerObject | null,
		options?: AddEventListenerOptions | boolean,
	) {
		if (type === "permissionrequest" && listener) this.#listeners++;
		super.addEventListener(type, listener, options);
	}
	override removeEventListener(
		type: string,
		listener: EventListenerOrEventListenerObject | null,
		options?: EventListenerOptions | boolean,
	) {
		if (type === "permissionrequest" && listener) this.#listeners = Math.max(0, this.#listeners - 1);
		super.removeEventListener(type, listener, options);
	}

	/** Latest metadata from the runtime (e.g. after a permission change). */
	update(app: AppInfo) {
		this.app = app;
		this.frame.contentWindow?.postMessage(
			{ iyowa: "host", type: "permissions", value: app.permissions },
			app.appOrigin,
		);
		this.dispatchEvent(new CustomEvent("update", { detail: app }));
	}

	/** Navigate the app to one of its own URLs (path, or isolated-app:// URL). */
	navigate(path: string) {
		const u = new URL(path.replace(`${this.app.origin}/`, `${this.app.appOrigin}/`), this.app.appOrigin);
		if (u.origin !== this.app.appOrigin || u.pathname.startsWith("/.iyowa/"))
			throw new Error("Not a URL of this app");
		this.frame.src = u.href;
		this.url = this.app.origin + u.pathname + u.search + u.hash;
	}
	reload() {
		this.navigate(this.url || this.app.startPath);
	}
	/** Open a URL through one of the app's manifest protocol_handlers. */
	openProtocol(input: string) {
		const u = new URL(input);
		const handler = this.app.manifest.protocol_handlers?.find((h) => `${h.protocol}:` === u.protocol);
		if (!handler) throw new Error(`${this.app.name} does not handle ${u.protocol} links`);
		this.navigate(handler.url.replace("%s", encodeURIComponent(u.href)));
	}
	/** Deliver a launch to the running app's launchQueue (launch_handler: navigate-existing). */
	deliverLaunch(targetURL: string, files: FileSystemHandle[] = []) {
		this.frame.contentWindow?.postMessage(
			{ iyowa: "host", type: "launch", targetURL, files },
			this.app.appOrigin,
		);
	}
	clearConsole() {
		this.console.length = 0;
		this.dispatchEvent(new CustomEvent("console", { detail: undefined }));
	}
	stop() {
		if (this.stopped) return;
		this.stopped = true;
		this.#ready.reject(new DOMException("Session stopped", "AbortError"));
		this.frame.remove();
		this.dispatchEvent(new Event("stop"));
	}
}

/** Human-readable descriptions of the manifest features the runtime understands. */
export function describeFeatures(app: AppInfo): { feature: string; label: string }[] {
	return Object.keys(app.manifest.permissions_policy ?? {}).map((feature) => ({
		feature,
		label: runtimeFeatures[feature] ?? feature,
	}));
}
