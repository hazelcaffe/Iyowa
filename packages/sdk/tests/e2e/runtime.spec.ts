import dgram from "node:dgram";
import { createServer } from "node:http";
import net from "node:net";
import { expect, test } from "@playwright/test";
import { WebSocketServer } from "ws";
import { probe } from "../../fixtures/probe.ts";
import { launch, prompts, startHost } from "./helpers.ts";

interface Opened {
	readable: ReadableStream;
	writable: WritableStream;
	localPort: number;
	localAddress: string;
	multicastController: { joinGroup(s: string): Promise<void> };
}
interface Socket {
	opened: Promise<Opened>;
	closed: Promise<void>;
	close(): Promise<void>;
}
declare global {
	var TCPSocket: new (h: string, p: number) => Socket;
	var UDPSocket: new (o: Record<string, unknown>) => Socket;
	var TCPServerSocket: new (h: string, o?: Record<string, unknown>) => Socket;
}
type CF = HTMLElement & {
	src: string;
	executeScript(o: { code: string }): Promise<unknown[]>;
	insertCSS(o: { code: string }): Promise<void>;
	clearData(o?: object, t?: object): Promise<void>;
	back(): Promise<boolean>;
	canGoBack(): Promise<boolean>;
	setZoom(n: number): Promise<void>;
	getZoom(): Promise<number>;
	request: { createWebRequestInterceptor(o: { urlPatterns: string[]; blocking: boolean }): EventTarget };
	contextMenus: EventTarget & {
		create(item: { id: string; title: string; contexts: string[] }): Promise<string>;
	};
};

let host: Awaited<ReturnType<typeof startHost>>;
let id: string;
let siteOrigin: string;
let tcpPort: number;
let udpPort: number;
const site = createServer((req, res) => {
	if (req.url === "/echo") return void res.end(String(req.headers["x-probe"]));
	if (req.url === "/block") return void res.end("should have been blocked");
	if (req.url === "/cookies") return void res.end(String(req.headers.cookie));
	if (req.url === "/cookie") res.setHeader("Set-Cookie", "flavor=oat; Path=/; SameSite=Lax");
	res.setHeader("Content-Type", "text/html");
	// Embedding-hostile headers: a controlled frame must still show the page.
	res.setHeader("X-Frame-Options", "DENY");
	res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
	res.end("<!doctype html><title>Partner site</title><h2>Partner site</h2>");
});
new WebSocketServer({ server: site, path: "/ws" }).on("connection", (ws) =>
	ws.on("message", (data) => ws.send(`pong ${data}`)),
);
const tcp = net.createServer((s) => s.pipe(s));
const udp = dgram.createSocket("udp4");

test.beforeAll(async () => {
	await new Promise<void>((ok) => site.listen(0, "127.0.0.1", ok));
	siteOrigin = `http://127.0.0.1:${(site.address() as net.AddressInfo).port}`;
	await new Promise<void>((ok) => tcp.listen(0, "127.0.0.1", ok));
	tcpPort = (tcp.address() as net.AddressInfo).port;
	await new Promise<void>((ok) => udp.bind(0, "127.0.0.1", ok));
	udpPort = udp.address().port;
	udp.on("message", (m, r) => udp.send(m, r.port, r.address));
	host = await startHost();
	id = (await host.install(await probe())).id;
});
test.afterAll(async () => {
	await host?.cleanup();
	site.close();
	tcp.close();
	udp.close();
});
test.beforeEach(async () => {
	await host.setPermission(id, "local-network", "prompt");
});

test("app documents: modules, workers, byte ranges and the app's own service worker", async ({ page }) => {
	const f = await launch(page, host, id);
	await expect(f.locator("#result")).toHaveText("ES module OK / worker function");
	expect(
		await f.evaluate(async () => {
			const r = await fetch("/bytes", { headers: { Range: "bytes=1-4" } });
			return [crossOriginIsolated, r.status, ...new Uint8Array(await r.arrayBuffer())];
		}),
	).toEqual([true, 206, 1, 2, 3, 254]);
	await f.evaluate(async () => {
		await navigator.serviceWorker.register("/sw.js");
		await navigator.serviceWorker.ready;
		if (!navigator.serviceWorker.controller)
			await new Promise((ok) =>
				navigator.serviceWorker.addEventListener("controllerchange", ok, { once: true }),
			);
	});
	expect(await f.evaluate(async () => (await fetch("/offline-probe")).text())).toBe("app service worker");
});

test("controlled frame: Scramjet-proxied bundle page, CSS and script injection, storage and zoom", async ({
	page,
}) => {
	const f = await launch(page, host, id);
	await expect(f.frameLocator("#view iframe").locator("#value")).toHaveText("Bundled JSON");
	expect(
		await f.evaluate(async () => {
			const cf = document.querySelector("#view") as CF;
			await cf.insertCSS({ code: "h2{color:rgb(10,20,30)}" });
			await cf.executeScript({ code: "localStorage.setItem('probe','managed')" });
			const values = await cf.executeScript({
				code: "[getComputedStyle(document.querySelector('h2')).color, localStorage.getItem('probe'), location.href]",
			});
			await cf.clearData({}, { localStorage: true });
			await cf.setZoom(1.5);
			return [
				values,
				await cf.executeScript({ code: "localStorage.getItem('probe')" }),
				localStorage.getItem("probe"),
				await cf.getZoom(),
			];
		}),
		// Inside the proxy, bundled pages run under a stand-in https origin (Scramjet only proxies http(s)).
	).toEqual([[["rgb(10, 20, 30)", "managed", "https://bundle.invalid/guest/"]], [null], null, 1.5]);
});

test("controlled frame: embedding-hostile LAN site, request interception, in-page and API history", async ({
	page,
}) => {
	await host.setPermission(id, "local-network", "granted");
	const f = await launch(page, host, id);
	const guest = f.frameLocator("#view iframe");
	await expect(guest.locator("#value")).toHaveText("Bundled JSON");
	// A link inside the page is a navigation the app observes (loadcommit) and can go back from.
	await guest.locator("#next").click();
	await expect(guest.locator("h2")).toHaveText("Second page");
	expect(
		await f.evaluate(async () => [
			(document.querySelector("#view") as CF).src,
			await (document.querySelector("#view") as CF).canGoBack(),
		]),
	).toEqual([`isolated-app://${id}/guest/next.html`, true]);
	expect(
		await f.evaluate(async (origin) => {
			const cf = document.querySelector("#view") as CF;
			await cf.executeScript({ code: "localStorage.setItem('marker','package')" });
			const loaded = new Promise((ok) => cf.addEventListener("loadstop", ok, { once: true }));
			cf.src = `${origin}/`;
			await loaded;
			const i = cf.request.createWebRequestInterceptor({
				urlPatterns: [`${origin}/*`],
				blocking: true,
			});
			i.addEventListener("beforerequest", (e) => {
				if ((e as Event & { url: string }).url.endsWith("/block")) e.preventDefault();
			});
			i.addEventListener("beforesendheaders", (e) => {
				const event = e as Event & { headers: Headers; setRequestHeaders(h: Headers): void };
				event.headers.set("X-Probe", "header received");
				event.setRequestHeaders(event.headers);
			});
			await new Promise((ok) => setTimeout(ok, 100));
			const value = await cf.executeScript({
				code: "Promise.all([document.title, localStorage.getItem('marker'), fetch('/echo').then(r => r.text()), fetch('/block').then(r => r.status)])",
			});
			const back = new Promise((ok) => cf.addEventListener("loadstop", ok, { once: true }));
			await cf.back();
			await back;
			return [
				value,
				await cf.executeScript({ code: "[location.pathname, localStorage.getItem('marker')]" }),
			];
		}, siteOrigin),
	).toEqual([[["Partner site", null, "header received", 403]], [["/guest/next.html", "package"]]]);
});

test("controlled frame: cookies, WebSockets and new-window requests on a proxied site", async ({ page }) => {
	await host.setPermission(id, "local-network", "granted");
	const f = await launch(page, host, id);
	await expect(f.frameLocator("#view iframe").locator("#value")).toHaveText("Bundled JSON");
	const result = await f.evaluate(async (origin) => {
		const cf = document.querySelector("#view") as CF;
		const load = () => new Promise((ok) => cf.addEventListener("loadstop", ok, { once: true }));
		let loaded = load();
		cf.src = `${origin}/cookie`;
		await loaded;
		const opened = new Promise<string>((ok) =>
			cf.addEventListener("newwindow", (e) => ok((e as Event & { targetUrl: string }).targetUrl), {
				once: true,
			}),
		);
		const [script] = await cf.executeScript({
			code: `new Promise((ok, no) => {
				const ws = new WebSocket(location.origin.replace("http", "ws") + "/ws");
				ws.onopen = () => ws.send("ping");
				ws.onmessage = (e) => { ws.close(); ok([document.cookie, e.data]); };
				ws.onerror = () => no(new Error("WebSocket failed"));
			})`,
		});
		await cf.executeScript({ code: "open('/popup', '_blank')" });
		const popup = await opened;
		loaded = load();
		cf.src = `${origin}/`;
		await loaded;
		const [echo] = await cf.executeScript({ code: "fetch('/cookies').then(r => r.text())" });
		return [script, popup, echo];
	}, siteOrigin);
	expect(result).toEqual([["flavor=oat", "pong ping"], `${siteOrigin}/popup`, "flavor=oat"]);
});

test("controlled frame: LAN pages need the local-network permission", async ({ page }) => {
	const f = await launch(page, host, id, { answer: "denied" });
	await expect(f.frameLocator("#view iframe").locator("#value")).toHaveText("Bundled JSON");
	const reason = await f.evaluate(async (origin) => {
		const cf = document.querySelector("#view") as CF;
		const aborted = new Promise<string>((ok) =>
			cf.addEventListener("loadabort", (e) => ok((e as Event & { reason: string }).reason), {
				once: true,
			}),
		);
		cf.src = `${origin}/`;
		return aborted;
	}, siteOrigin);
	expect(reason).toContain("not allowed");
	expect((await prompts(page))[0]?.name).toBe("local-network");
});

test("controlled frame: the app's context menu items replace the page menu", async ({ page }) => {
	const f = await launch(page, host, id);
	const guest = f.frameLocator("#view iframe");
	await expect(guest.locator("#value")).toHaveText("Bundled JSON");
	await f.evaluate(async () => {
		const el = document.querySelector("#view") as CF;
		await el.contextMenus.create({ id: "demo", title: "Selected action", contexts: ["page"] });
		el.contextMenus.addEventListener("click", (e) => {
			el.dataset.click = `${(e as Event & { menuItemId: string; pageUrl: string }).menuItemId} ${(e as Event & { pageUrl: string }).pageUrl}`;
		});
	});
	await guest.locator("h2").click({ button: "right" });
	await guest.getByRole("menuitem", { name: "Selected action" }).click();
	await expect(f.locator("#view")).toHaveAttribute("data-click", `demo isolated-app://${id}/guest/`);
});

test("sockets stay in-app when local network access is blocked: TCP accept/BYOB/EOF, UDP and multicast", async ({
	page,
}) => {
	const f = await launch(page, host, id, { answer: "denied" });
	expect(
		await f.evaluate(async () => {
			const server = new TCPServerSocket("::1"),
				s = await server.opened,
				accept = s.readable.getReader();
			const client = new TCPSocket("::1", s.localPort);
			const a = await client.opened;
			const peer = (await accept.read()).value as Socket;
			const remote = await peer.opened;
			const writer = a.writable.getWriter();
			await writer.write(new Uint8Array([0, 254]));
			writer.releaseLock();
			const reader = remote.readable.getReader({ mode: "byob" });
			const { value } = await reader.read(new Uint8Array(4));
			await client.close();
			const eof = await reader.read(new Uint8Array(1));
			accept.releaseLock();
			await server.close();
			const u = new UDPSocket({ localAddress: "127.0.0.1" }),
				info = await u.opened;
			await info.multicastController.joinGroup("239.1.1.1");
			const r = info.readable.getReader();
			const datagrams: number[] = [];
			for (const h of ["127.0.0.1", "239.1.1.1"]) {
				const c = new UDPSocket({ remoteAddress: h, remotePort: info.localPort });
				const w = (await c.opened).writable.getWriter();
				await w.write({ data: new Uint8Array([37]) });
				w.releaseLock();
				datagrams.push((await r.read()).value.data[0]);
				await c.close();
			}
			r.releaseLock();
			await u.close();
			return [Array.from(value || []), eof.done, datagrams];
		}),
	).toEqual([[0, 254], true, [37, 37]]);
	expect((await prompts(page)).map((p) => p.name)).toContain("local-network");
});

test("granting local network access in the prompt reaches real TCP and UDP services through Wisp", async ({
	page,
}) => {
	const f = await launch(page, host, id, { answer: "granted" });
	expect(
		await f.evaluate(
			async ([t, u]) => {
				const results = [];
				const tcpSocket = new TCPSocket("127.0.0.1", t);
				const o = await tcpSocket.opened;
				const w = o.writable.getWriter(),
					r = o.readable.getReader();
				await w.write(new Uint8Array([0, 255, 62]));
				results.push(Array.from((await r.read()).value));
				w.releaseLock();
				r.releaseLock();
				await tcpSocket.close();
				const udpSocket = new UDPSocket({ remoteAddress: "127.0.0.1", remotePort: u });
				const uo = await udpSocket.opened;
				const uw = uo.writable.getWriter(),
					ur = uo.readable.getReader();
				await uw.write({ data: new Uint8Array([7, 8]) });
				results.push(Array.from((await ur.read()).value.data));
				uw.releaseLock();
				ur.releaseLock();
				await udpSocket.close();
				// Nothing listens here: opened must reject (the relay acknowledges real connections only).
				const refused = await new TCPSocket("127.0.0.1", 1).opened.then(
					() => "opened",
					(e: Error) => e.name,
				);
				return [results, refused];
			},
			[tcpPort, udpPort],
		),
	).toEqual([
		[
			[0, 255, 62],
			[7, 8],
		],
		"NetworkError",
	]);
	expect(host.list().find((a) => a.id === id)?.permissions["local-network"]).toBe("granted");
});

test("with local network access, listeners are real OS sockets", async ({ page }) => {
	await host.setPermission(id, "local-network", "granted");
	const f = await launch(page, host, id);
	const ports = await f.evaluate(async () => {
		const server = new TCPServerSocket("127.0.0.1"),
			bound = new UDPSocket({ localAddress: "::1" }),
			s = await server.opened,
			u = await bound.opened;
		void (async () => {
			const incoming = s.readable.getReader();
			const peer = (await incoming.read()).value as Socket;
			const o = await peer.opened;
			const reader = o.readable.getReader(),
				writer = o.writable.getWriter();
			await writer.write((await reader.read()).value);
		})();
		void (async () => {
			const r = u.readable.getReader(),
				w = u.writable.getWriter();
			await w.write((await r.read()).value);
		})();
		return [s.localPort, u.localPort];
	});
	const got = await new Promise<Buffer>((ok, no) => {
		const c = net.connect(ports[0] as number, "127.0.0.1", () => c.write(Buffer.from([4, 0, 255])));
		c.once("error", no);
		c.once("data", (b) => {
			ok(Buffer.from(b));
			c.end();
		});
	});
	expect([...got]).toEqual([4, 0, 255]);
	const d = dgram.createSocket("udp6");
	try {
		const reply = new Promise<Buffer>((ok, no) => {
			d.once("message", ok);
			d.once("error", no);
		});
		d.send(Buffer.from([0, 9]), ports[1], "::1");
		expect([...(await reply)]).toEqual([0, 9]);
	} finally {
		d.close();
	}
});

test("a dedicated module worker connects to its window's listener", async ({ page }) => {
	const f = await launch(page, host, id, { answer: "denied" });
	expect(
		await f.evaluate(async () => {
			const s = new TCPServerSocket("::1"),
				info = await s.opened,
				r = info.readable.getReader(),
				w = new Worker("./echo-worker.js", { type: "module" });
			const ack = new Promise((ok) => {
				w.onmessage = (e) => ok(e.data);
			});
			w.postMessage(info.localPort);
			const peer = (await r.read()).value as Socket;
			const data = await (await peer.opened).readable.getReader().read();
			const reply = await ack;
			w.terminate();
			return [data.value[0], reply];
		}),
	).toEqual([91, "done"]);
});

test("SDK sessions: protocol handlers, launchQueue and persistent app storage", async ({ page }) => {
	const f = await launch(page, host, id);
	await f.evaluate(() => localStorage.setItem("note", "remember"));
	await page.evaluate(() =>
		(
			window as unknown as { iyowa: { session: { openProtocol(u: string): void } } }
		).iyowa.session.openProtocol("lab://open/note"),
	);
	await expect
		.poll(() =>
			page
				.frames()
				.find((x) => x.url().includes(id))
				?.url(),
		)
		.toContain("lab%3A%2F%2Fopen%2Fnote");
	const app = page.frameLocator("main iframe");
	await expect(app.locator("#result")).toContainText("worker function");
	const again = page.frames().find((x) => x.url().includes(id));
	expect(await again?.evaluate(() => localStorage.getItem("note"))).toBe("remember");
	await again?.evaluate(() =>
		(
			window as unknown as {
				launchQueue: { setConsumer(cb: (l: { targetURL: string }) => void): void };
			}
		).launchQueue.setConsumer((l) => {
			document.body.dataset.lastLaunch = l.targetURL;
		}),
	);
	await page.evaluate(() =>
		(
			window as unknown as { iyowa: { session: { deliverLaunch(u: string): void } } }
		).iyowa.session.deliverLaunch("lab://second"),
	);
	await expect(app.locator("body")).toHaveAttribute("data-last-launch", "lab://second");
});

test("capabilities the manifest doesn't grant fail with NotAllowedError", async ({ page }) => {
	const { generateKeyPairSync } = await import("node:crypto");
	const other = await host.install(
		await probe({ permissions_policy: {} }, generateKeyPairSync("ed25519").privateKey),
	);
	const f = await launch(page, host, other.id);
	expect(
		await f.evaluate(() => {
			try {
				new TCPServerSocket("::1");
				return "";
			} catch (e) {
				return (e as Error).name;
			}
		}),
	).toBe("NotAllowedError");
	await expect(f.locator("#view")).toContainText("does not grant");
});
