import { SCRAMJETCLIENT, ScramjetClient } from "@mercuryworkshop/scramjet";
import { frameContext, type Natives, workerTransport } from "./context.ts";

// Prepended (via Scramjet's worker rewriter) to workers that proxied pages start.
const natives: Natives = {
	Worker: globalThis.Worker,
	fetch: globalThis.fetch.bind(globalThis),
	listen: EventTarget.prototype.addEventListener,
	post: globalThis.Worker?.prototype.postMessage,
};
const boot = globalThis.__iyowaFrameBoot ?? { cookies: "", headers: [], history: [] };
if (!Reflect.get(globalThis, SCRAMJETCLIENT)) {
	const context = frameContext();
	if (boot.cookies) context.cookieJar.load(boot.cookies);
	const client = new ScramjetClient(globalThis as never, {
		context,
		transport: workerTransport(natives),
		initHeaders: [],
		history: [],
		sendSetCookie: async (cookies) => {
			const controller = (navigator as Navigator & { serviceWorker?: ServiceWorkerContainer })
				.serviceWorker?.controller;
			controller?.postMessage({
				iyowa: "cookies",
				cookies: cookies.map((entry) => ({ url: String(entry.url), cookie: entry.cookie })),
			});
		},
		hookSubcontext: () => {
			throw new Error("Workers have no subframes");
		},
	});
	client.hook();
}
