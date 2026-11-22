import { signApp, testKey } from "./sign.ts";

// Example IWAs shipped with Iyowa. They are signed with public demo keys.

const ICON = (hue: number, glyph: string) =>
	`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" rx="22" fill="hsl(${hue} 70% 45%)"/><text x="48" y="63" font-family="system-ui,sans-serif" font-size="44" font-weight="700" text-anchor="middle" fill="#fff">${glyph}</text></svg>`;

const BASE_CSS = `
:root { color-scheme: light dark; font: 14px/1.45 system-ui, sans-serif; --line: color-mix(in srgb, CanvasText 15%, transparent); }
* { box-sizing: border-box; }
body { margin: 0; height: 100vh; display: flex; flex-direction: column; }
header { display: flex; gap: 6px; align-items: center; padding: 8px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
button, input, select { font: inherit; padding: 5px 10px; border-radius: 7px; border: 1px solid var(--line); background: Canvas; color: CanvasText; }
button:hover:not(:disabled) { background: color-mix(in srgb, CanvasText 7%, Canvas); }
button[aria-pressed="true"] { background: Highlight; color: HighlightText; }
input { flex: 1; min-width: 12ch; }
.log { font: 12px ui-monospace, monospace; white-space: pre-wrap; overflow: auto; margin: 0; padding: 8px; }
.muted { color: GrayText; }
`;

export function frameLab() {
	return signApp(
		{
			name: "Controlled Frame Lab",
			short_name: "Frame Lab",
			description:
				"A small browser built on <controlledframe>: navigation, script and CSS injection, request blocking and context menus.",
			version: "1.0.0",
			start_url: "/",
			display: "standalone",
			icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
			permissions_policy: { "cross-origin-isolated": ["self"], "controlled-frame": ["self"] },
		},
		{
			"/icon.svg": ICON(205, "⧉"),
			"/": `<!doctype html><meta charset="utf-8"><title>Controlled Frame Lab</title><link rel="stylesheet" href="/lab.css">
<header>
	<button id="back" title="Back">←</button><button id="forward" title="Forward">→</button><button id="reload" title="Reload">⟳</button>
	<form id="go"><input id="url" aria-label="Address" value="https://en.wikipedia.org/wiki/Special:Random" spellcheck="false"></form>
</header>
<header class="tools">
	<button data-url="https://en.wikipedia.org/wiki/Isolated_Web_App">Wikipedia</button>
	<button data-url="https://www.google.com/">Google</button>
	<button data-url="https://example.com/">example.com</button>
	<button data-url="/guest.html">Bundled page</button>
	<span class="sep"></span>
	<button id="css">Highlight links</button><button id="title">Read title</button><button id="images" aria-pressed="false">Block images</button><button id="clear">Clear site data</button>
</header>
<main><controlledframe id="frame" partition="persist:lab" src="/guest.html"></controlledframe><pre id="log" class="log" aria-live="polite"></pre></main>
<script src="/lab.js"></script>`,
			"/lab.css": `${BASE_CSS}
.tools { padding-top: 0; border-bottom: 0; }
.sep { flex: 1; }
main { flex: 1; display: grid; grid-template-rows: 1fr 140px; min-height: 0; }
controlledframe { border-block: 1px solid var(--line); }
#log { border-top: 1px solid var(--line); }`,
			"/guest.html": `<!doctype html><meta charset="utf-8"><title>Bundled page</title><style>body{font:16px system-ui;margin:2rem;max-width:60ch}</style>
<h1>Hello from the bundle</h1><p>This page is part of the signed app and is loaded into a controlled frame through the Scramjet proxy, just like remote sites.</p>
<p>Select some text and right-click to try the app's custom context menu, or <a href="https://example.com/" target="_blank">open a new window</a>.</p>`,
			"/lab.js": `const frame = document.getElementById("frame");
const url = document.getElementById("url");
const log = document.getElementById("log");
const write = (text) => { log.textContent = \`\${new Date().toLocaleTimeString()}  \${text}\\n\` + log.textContent.slice(0, 20000); };

document.getElementById("go").addEventListener("submit", (e) => {
	e.preventDefault();
	let target = url.value.trim();
	if (!/^[a-z]+:|^\\//i.test(target)) target = target.includes(".") && !target.includes(" ") ? \`https://\${target}\` : \`https://duckduckgo.com/html/?q=\${encodeURIComponent(target)}\`;
	frame.src = target;
});
for (const button of document.querySelectorAll("[data-url]")) button.addEventListener("click", () => { frame.src = button.dataset.url; });
document.getElementById("back").onclick = () => frame.back();
document.getElementById("forward").onclick = () => frame.forward();
document.getElementById("reload").onclick = () => frame.reload();
document.getElementById("css").onclick = () => frame.insertCSS({ code: "a { background: gold !important; color: black !important; outline: 2px solid orange; }" }).then(() => write("insertCSS ✓"), (e) => write(\`insertCSS failed: \${e.message}\`));
document.getElementById("title").onclick = async () => {
	try { const [title] = await frame.executeScript({ code: "document.title" }); write(\`executeScript → \${JSON.stringify(title)}\`); }
	catch (e) { write(\`executeScript failed: \${e.message}\`); }
};
document.getElementById("clear").onclick = () => frame.clearData({}, { cookies: true, localStorage: true, sessionStorage: true, indexedDB: true, cacheStorage: true }).then(() => write("clearData ✓"), (e) => write(\`clearData failed: \${e.message}\`));

let blocker;
document.getElementById("images").onclick = (e) => {
	const on = e.currentTarget.getAttribute("aria-pressed") !== "true";
	e.currentTarget.setAttribute("aria-pressed", String(on));
	if (on) {
		blocker = frame.request.createWebRequestInterceptor({ urlPatterns: ["<all_urls>"], resourceTypes: ["image"], blocking: true });
		blocker.addEventListener("beforerequest", (event) => { event.preventDefault(); write(\`blocked image \${event.request.url}\`); });
	} else frame.request.removeWebRequestInterceptor(blocker);
	frame.reload();
};

frame.contextMenus.create({ id: "search", title: 'Search Wikipedia for "%s"', contexts: ["selection"] });
frame.contextMenus.addEventListener("click", (e) => {
	if (e.menuItemId === "search") frame.src = \`https://en.wikipedia.org/w/index.php?search=\${encodeURIComponent(e.selectionText)}\`;
});

frame.addEventListener("loadstart", (e) => { url.value = e.url; write(\`loadstart \${e.url}\`); });
frame.addEventListener("loadredirect", (e) => write(\`loadredirect \${e.oldUrl} → \${e.newUrl}\`));
frame.addEventListener("loadcommit", (e) => { url.value = e.url; write(\`loadcommit \${e.url}\`); });
frame.addEventListener("loadstop", () => write("loadstop"));
frame.addEventListener("loadabort", (e) => write(\`loadabort \${e.reason}\`));
frame.addEventListener("consolemessage", (e) => write(\`console: \${e.message}\`));
frame.addEventListener("newwindow", (e) => { write(\`newwindow \${e.targetUrl} (opened here)\`); e.window.attach(frame); });
`,
		},
		testKey("Iyowa example: Controlled Frame Lab"),
	);
}

export function socketLab() {
	return signApp(
		{
			name: "Socket Lab",
			description:
				"Direct Sockets playground: raw TCP clients, a TCP server and UDP (DNS) over the runtime's relay.",
			version: "1.0.0",
			start_url: "/",
			display: "standalone",
			icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
			permissions_policy: {
				"cross-origin-isolated": ["self"],
				"direct-sockets": ["self"],
				"direct-sockets-private": ["self"],
			},
		},
		{
			"/icon.svg": ICON(150, "⇄"),
			"/": `<!doctype html><meta charset="utf-8"><title>Socket Lab</title><link rel="stylesheet" href="/lab.css">
<header>
	<strong>TCP</strong>
	<input id="host" aria-label="Host" value="example.com" spellcheck="false" style="max-width:24ch"><input id="port" aria-label="Port" value="80" inputmode="numeric" style="max-width:8ch;flex:0">
	<button id="connect">Connect</button><button id="disconnect" disabled>Close</button>
	<select id="preset" aria-label="Presets"><option value="">Presets…</option><option value="example.com 80 http">HTTP GET example.com</option><option value="tcpbin.com 4242">tcpbin.com echo</option><option value="towel.blinkenlights.nl 23">Star Wars (telnet)</option></select>
</header>
<header><input id="line" aria-label="Send" placeholder="Text to send (Enter)" disabled><label><input type="checkbox" id="crlf" checked> CRLF</label></header>
<pre id="tcp" class="log"></pre>
<header><strong>Server</strong><button id="listen">Listen on 127.0.0.1</button><span id="server" class="muted">Not listening</span>
<strong style="margin-left:auto">UDP</strong><input id="name" aria-label="DNS name" value="example.com" style="max-width:20ch"><button id="dns">Resolve via 1.1.1.1</button></header>
<pre id="misc" class="log"></pre>
<script src="/lab.js"></script>`,
			"/lab.css": `${BASE_CSS}
#tcp { flex: 2; border-bottom: 1px solid var(--line); }
#misc { flex: 1; }`,
			"/lab.js": `const $ = (id) => document.getElementById(id);
const out = (el, text) => { el.textContent += text; el.scrollTop = el.scrollHeight; };
const decoder = new TextDecoder();
let socket, writer;

async function connect() {
	const host = $("host").value.trim(), port = Number($("port").value);
	out($("tcp"), \`\\n— connecting to \${host}:\${port}…\\n\`);
	$("connect").disabled = true;
	try {
		socket = new TCPSocket(host, port);
		const { readable, writable, remoteAddress, localPort } = await socket.opened;
		out($("tcp"), \`— connected to \${remoteAddress} (local port \${localPort ?? "?"})\\n\`);
		writer = writable.getWriter();
		$("line").disabled = false; $("disconnect").disabled = false; $("line").focus();
		if ($("preset").value.endsWith("http")) await send(\`GET / HTTP/1.1\\r\\nHost: \${host}\\r\\nConnection: close\\r\\n\`);
		const reader = readable.getReader();
		for (;;) { const { value, done } = await reader.read(); if (done) break; out($("tcp"), decoder.decode(value, { stream: true })); }
		out($("tcp"), "\\n— connection closed by peer\\n");
	} catch (e) { out($("tcp"), \`— \${e.name}: \${e.message}\\n\`); }
	finally { reset(); }
}
function reset() { writer = undefined; socket = undefined; $("connect").disabled = false; $("disconnect").disabled = true; $("line").disabled = true; }
async function send(text) { await writer?.write(new TextEncoder().encode(text + ($("crlf").checked ? "\\r\\n" : "\\n"))); }

$("connect").onclick = connect;
$("disconnect").onclick = async () => { try { writer?.releaseLock(); await socket?.close(); } catch {} reset(); };
$("line").addEventListener("keydown", async (e) => { if (e.key === "Enter") { const t = e.target.value; e.target.value = ""; out($("tcp"), \`» \${t}\\n\`); await send(t); } });
$("preset").onchange = () => { const [h, p] = $("preset").value.split(" "); if (h) { $("host").value = h; $("port").value = p; connect(); } };

$("listen").onclick = async () => {
	$("listen").disabled = true;
	try {
		const server = new TCPServerSocket("127.0.0.1");
		const { readable, localAddress, localPort } = await server.opened;
		$("server").textContent = \`Echoing on \${localAddress}:\${localPort} — try “Connect” to 127.0.0.1:\${localPort}\`;
		$("host").value = "127.0.0.1"; $("port").value = localPort;
		for await (const client of readable) {
			const { readable: r, writable: w, remoteAddress, remotePort } = await client.opened;
			out($("misc"), \`server: connection from \${remoteAddress}:\${remotePort}\\n\`);
			r.pipeTo(w).catch(() => {});
		}
	} catch (e) { $("server").textContent = \`\${e.name}: \${e.message}\`; $("listen").disabled = false; }
};

$("dns").onclick = async () => {
	const name = $("name").value.trim();
	const labels = name.split(".").filter(Boolean);
	const q = [0x12, 0x34, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0];
	for (const l of labels) q.push(l.length, ...new TextEncoder().encode(l));
	q.push(0, 0, 1, 0, 1);
	try {
		const udp = new UDPSocket({ remoteAddress: "1.1.1.1", remotePort: 53 });
		const { readable, writable } = await udp.opened;
		const w = writable.getWriter(); await w.write({ data: new Uint8Array(q) }); w.releaseLock();
		const r = readable.getReader();
		const timeout = setTimeout(() => r.cancel(), 4000);
		const { value } = await r.read(); clearTimeout(timeout); r.releaseLock();
		const d = value.data, answers = (d[6] << 8) | d[7];
		let i = q.length; const ips = [];
		for (let a = 0; a < answers && i < d.length; a++) {
			i += 2; const type = (d[i] << 8) | d[i + 1]; i += 8; const len = (d[i] << 8) | d[i + 1]; i += 2;
			if (type === 1 && len === 4) ips.push([...d.slice(i, i + 4)].join("."));
			i += len;
		}
		out($("misc"), \`udp: \${name} → \${ips.join(", ") || "no A records"}\\n\`);
		await udp.close();
	} catch (e) { out($("misc"), \`udp: \${e.name}: \${e.message}\\n\`); }
};
`,
		},
		testKey("Iyowa example: Socket Lab"),
	);
}
