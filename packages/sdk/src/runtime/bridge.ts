import type { GuestConfig, PermissionName, PermissionState } from "../shared/types.ts";

/** Messages from app documents to the launcher SDK. */
export type GuestEvent =
	| { type: "ready"; detail: { url: string; title: string } }
	| { type: "title"; detail: { title: string } }
	| { type: "console"; detail: { level: string; message: string } }
	| { type: "error"; detail: { message: string } }
	| { type: "socket"; detail: SocketEvent }
	| { type: "permission"; id: string; detail: { name: PermissionName; reason: string } };

export interface SocketEvent {
	id: string;
	kind: "tcp" | "tcp-server" | "udp";
	route: "in-app" | "network" | "system";
	state: "opening" | "open" | "closed" | "failed";
	local?: string;
	remote?: string;
	error?: string;
	sent?: number;
	received?: number;
}

/** In a document, the launcher is the top-level window (popups are nested app frames). */
const launcher = typeof document !== "undefined" && window.top !== window ? window.top : null;

export function createBridge(config: GuestConfig) {
	const pending = new Map<string, (value: unknown) => void>();
	const post = (message: GuestEvent) =>
		launcher?.postMessage({ iyowa: "guest", ...message }, config.shellOrigin);
	if (launcher)
		addEventListener("message", (e) => {
			if (e.source !== launcher || e.origin !== config.shellOrigin || e.data?.iyowa !== "host") return;
			if (e.data.type === "reply") {
				pending.get(e.data.id)?.(e.data.value);
				pending.delete(e.data.id);
			} else if (e.data.type === "permissions") Object.assign(config.permissions, e.data.value);
		});
	let budget = 200,
		refill = 0;
	return {
		connected: !!launcher,
		post(event: Exclude<GuestEvent, { type: "permission" }>) {
			// Don't let a logging loop flood the launcher.
			const now = Date.now();
			if (now - refill > 1000) {
				refill = now;
				budget = 200;
			}
			if (event.type === "console" && --budget < 0) return;
			post(event);
		},
		/** Current state, asking the user (through the launcher) if it is still undecided. */
		async permission(name: PermissionName, reason: string): Promise<PermissionState> {
			const known = config.permissions[name];
			if (known !== "prompt" || !launcher) return known;
			const id = crypto.randomUUID();
			const state = await new Promise<unknown>((ok) => {
				pending.set(id, ok);
				post({ type: "permission", id, detail: { name, reason } });
			});
			const result: PermissionState = state === "granted" || state === "denied" ? state : "prompt";
			config.permissions[name] = result;
			return result;
		},
	};
}

export type Bridge = ReturnType<typeof createBridge>;
