// Served with the service worker's "can't reach this page" document.
const reason = document.querySelectorAll("p")[1]?.textContent || "The page could not be loaded";
const url = document.querySelector("code")?.textContent || "";
if (window.frameElement === null)
	parent.postMessage(
		{ iyowa: "frame", kind: "event", name: "loadabort", fields: { url, reason } },
		globalThis.__iyowaFrame.parent,
	);
