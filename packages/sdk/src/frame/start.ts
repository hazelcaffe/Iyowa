// First document of a controlled-frame partition: install the Scramjet service worker, then
// replace itself with the proxied page. The target URL arrives in the fragment.
const target = decodeURIComponent(location.hash.slice(1));
void (async () => {
	const services = navigator.serviceWorker;
	await services.register("/.iyowa/sw.js", { scope: "/", updateViaCache: "none" });
	await services.ready;
	if (!services.controller)
		await new Promise((ok) => services.addEventListener("controllerchange", ok, { once: true }));
	location.replace(`/view/${encodeURIComponent(target)}`);
})().catch((e) => {
	parent.postMessage(
		{
			iyowa: "frame",
			kind: "event",
			name: "loadabort",
			fields: {
				url: target,
				reason: `The frame proxy could not start: ${String((e as Error)?.message ?? e)}`,
			},
		},
		globalThis.__iyowaFrame.parent,
	);
});
