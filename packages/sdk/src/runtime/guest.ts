import type { GuestConfig } from "../shared/types.ts";
import { createBridge } from "./bridge.ts";
import { installCapture } from "./capture.ts";
import { installFrames } from "./controlled-frame.ts";
import { installDisplay } from "./display.ts";
import { installPopups } from "./popups.ts";
import { installSockets } from "./sockets.ts";

declare global {
	var __iyowaConfig: GuestConfig | undefined;
}

const config = globalThis.__iyowaConfig as GuestConfig;
const bridge = createBridge(config);
const toVirtual = (url: string) => url.replace(`${location.origin}/`, `isolated-app://${config.id}/`);
const toReal = (url: string) => url.replace(`isolated-app://${config.id}/`, `${location.origin}/`);

installDisplay(config);
installCapture(config);
installPopups(config);
installSockets(config, bridge, (detail) => bridge.post({ type: "socket", detail }));
installFrames(config, bridge);

// Same-ID isolated-app: URLs in script-built requests address the bundle.
const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, init) =>
	nativeFetch(typeof input === "string" || input instanceof URL ? toReal(String(input)) : input, init);

// Launch Handler API. The first launch is this navigation; the launcher can deliver more.
type Launch = { targetURL: string; files: FileSystemHandle[] };
let consumer: ((launch: Launch) => void) | undefined;
const launches: Launch[] = [{ targetURL: toVirtual(location.href), files: [] }];
const flush = () => {
	while (consumer && launches.length) {
		const next = launches.shift();
		if (next) consumer(next);
	}
};
Object.defineProperty(window, "launchQueue", {
	configurable: true,
	value: {
		setConsumer(fn: (launch: Launch) => void) {
			consumer = fn;
			queueMicrotask(flush);
		},
	},
});
addEventListener("message", (e) => {
	if (
		e.origin === config.shellOrigin &&
		e.source === window.top &&
		e.data?.iyowa === "host" &&
		e.data.type === "launch"
	) {
		launches.push({ targetURL: String(e.data.targetURL), files: e.data.files || [] });
		flush();
	}
});

// Developer tools: console output, uncaught errors, document title.
const format = (value: unknown): string => {
	if (typeof value === "string") return value;
	if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
};
for (const level of ["log", "info", "warn", "error", "debug"] as const) {
	const native = console[level].bind(console);
	console[level] = (...args: unknown[]) => {
		native(...args);
		bridge.post({
			type: "console",
			detail: { level, message: args.map(format).join(" ").slice(0, 4000) },
		});
	};
}
addEventListener("error", (e) =>
	bridge.post({ type: "error", detail: { message: e.error ? format(e.error) : e.message } }),
);
addEventListener("unhandledrejection", (e) =>
	bridge.post({ type: "error", detail: { message: `Unhandled rejection: ${format(e.reason)}` } }),
);
const isPopup = window.frameElement?.hasAttribute("data-iyowa-popup") ?? false;
if (!isPopup) {
	addEventListener("DOMContentLoaded", () => {
		bridge.post({ type: "ready", detail: { url: toVirtual(location.href), title: document.title } });
		let title = document.title;
		new MutationObserver(() => {
			if (document.title === title) return;
			title = document.title;
			bridge.post({ type: "title", detail: { title } });
		}).observe(document.head || document.documentElement, {
			subtree: true,
			childList: true,
			characterData: true,
		});
	});
}
