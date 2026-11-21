import { installCapture } from "./capture.ts";
import { installFrames } from "./controlled-frame.ts";
import { installDisplay } from "./display.ts";
import { installPopups } from "./popups.ts";
import { installSockets } from "./sockets.ts";
import type { GuestConfig } from "./types.ts";

declare global {
	var __iyowaConfig: GuestConfig;
}
const cfg = globalThis.__iyowaConfig;
installDisplay(cfg);
installCapture(cfg);
installPopups(cfg);
installSockets(cfg);
installFrames(cfg);
const virtual = (url: string) => url.replace(`${location.origin}/`, `isolated-app://${cfg.id}/`);
const nativeFetch = fetch.bind(globalThis);
globalThis.fetch = (input, init) =>
	nativeFetch(
		typeof input === "string" || input instanceof URL
			? String(input).replace(`isolated-app://${cfg.id}/`, `${location.origin}/`)
			: input,
		init,
	);
type Launch = { targetURL: string; files: FileSystemFileHandle[] };
let consumer: ((launch: Launch) => void) | undefined;
const queue: Launch[] = [{ targetURL: virtual(location.href), files: [] }];
function flush() {
	while (consumer && queue.length) {
		const item = queue.shift();
		if (item) consumer(item);
	}
}
Object.defineProperty(window, "launchQueue", {
	configurable: true,
	value: {
		setConsumer: (fn: typeof consumer) => {
			consumer = fn;
			queueMicrotask(flush);
		},
	},
});
addEventListener("message", (e) => {
	if (e.origin === cfg.shellOrigin && e.source === parent && e.data?.iyowa === "launch") {
		queue.push({ targetURL: e.data.targetURL, files: e.data.files || [] });
		flush();
	}
});
const popup = window.frameElement?.hasAttribute("data-iyowa-popup");
const notify = (type: string, detail: unknown) =>
	parent.postMessage(
		{ iyowa: popup ? "popup" : "runtime", type, detail },
		popup ? location.origin : cfg.shellOrigin,
	);
addEventListener("error", (e) => notify("error", e.message));
addEventListener("unhandledrejection", (e) => notify("error", String(e.reason)));
addEventListener("DOMContentLoaded", () =>
	notify("ready", { title: document.title, url: virtual(location.href) }),
);
