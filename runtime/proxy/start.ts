void (async () => {
	await navigator.serviceWorker.register("/.iyowa/proxy-sw.js", { scope: "/" });
	await navigator.serviceWorker.ready;
	if (!navigator.serviceWorker.controller)
		await new Promise((ok) =>
			navigator.serviceWorker.addEventListener("controllerchange", ok, { once: true }),
		);
	location.replace(`/view/${encodeURIComponent(decodeURIComponent(location.hash.slice(1)))}`);
})().catch((e) => {
	parent.postMessage(
		{
			iyowa: "event",
			name: "loadabort",
			fields: { reason: `Cannot start the Scramjet service worker: ${String(e)}` },
		},
		globalThis.__iyowaFrame.parent,
	);
});
