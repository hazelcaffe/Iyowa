import dgram from "node:dgram";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { fixture } from "../fixtures/bundle.ts";
import { createHost } from "../host/index.ts";
import { readBundle } from "../runtime/bundle.ts";
import type { AppInfo, IwaRuntime, IwaSession } from "../sdk/index.ts";

interface Socket {
	opened: Promise<{
		readable: ReadableStream;
		writable: WritableStream;
		localPort: number;
		multicastController: { joinGroup(s: string): Promise<void> };
	}>;
	closed: Promise<void>;
	close(): Promise<void>;
}
declare global {
	var TCPSocket: new (h: string, p: number) => Socket;
	var UDPSocket: new (o: Record<string, unknown>) => Socket;
	var TCPServerSocket: new (h: string) => Socket;
}
interface CF extends HTMLElement {
	src: string;
	executeScript(o: { code: string }): Promise<unknown[]>;
	insertCSS(o: { code: string }): Promise<void>;
	clearData(o?: object, t?: object): Promise<void>;
	back(): Promise<boolean>;
	setZoom(n: number): Promise<void>;
	getZoom(): Promise<number>;
}
interface ManagedCF extends CF {
	partition: string;
	request: { createWebRequestInterceptor(o: { urlPatterns: string[]; blocking: boolean }): EventTarget };
}
interface MenuCF extends CF {
	contextMenus: EventTarget & {
		create(item: { id: string; title: string; contexts: string[] }): Promise<string>;
	};
}
const site = createServer((req, res) => {
	res.setHeader("Access-Control-Allow-Origin", "*");
	res.setHeader("Access-Control-Allow-Headers", "X-Probe");
	res.setHeader("Access-Control-Expose-Headers", "X-Iyowa-Embed");
	res.setHeader("X-Iyowa-Embed", "allow");
	if (req.method === "OPTIONS") {
		res.writeHead(204);
		res.end();
		return;
	}
	if (req.url === "/echo") {
		res.end(String(req.headers["x-probe"]));
		return;
	}
	res.setHeader("Content-Type", "text/html");
	res.end("<!doctype html><title>Partner site</title><h2>Partner site</h2>");
});
let siteOrigin: string;
let host: Awaited<ReturnType<typeof createHost>>, dir: string, tcpPort: number, udpPort: number, id: string;
const tcp = net.createServer((s) => s.pipe(s)),
	udp = dgram.createSocket("udp4");
test.beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "iyowa-browser-"));
	await new Promise<void>((ok) => tcp.listen(0, "127.0.0.1", ok));
	tcpPort = (tcp.address() as net.AddressInfo).port;
	await new Promise<void>((ok) => udp.bind(0, "127.0.0.1", ok));
	udpPort = udp.address().port;
	udp.on("message", (m, r) => udp.send(m, r.port, r.address));
	id = readBundle(await fixture()).id;
	await new Promise<void>((ok) => site.listen(0, "127.0.0.1", ok));
	siteOrigin = `http://127.0.0.1:${(site.address() as net.AddressInfo).port}`;
	host = await createHost({
		port: 0,
		dataDir: dir,
		managedOrigins: [siteOrigin],
		bindings: [
			{ id, protocol: "tcp", address: "127.0.0.1", port: 0 },
			{ id, protocol: "udp", address: "::1", port: 0 },
		],
		grants: [
			{ id, protocol: "tcp", address: "127.0.0.1", port: tcpPort },
			{ id, protocol: "udp", address: "127.0.0.1", port: udpPort },
		],
	});
});
test.afterAll(async () => {
	await host?.close();
	site.close();
	tcp.close();
	udp.close();
	await rm(dir, { recursive: true, force: true });
});
async function launch(page: Page) {
	await page.goto(host.origin);
	await page.getByRole("button", { name: "Example", exact: true }).click();
	await expect(page.locator("output")).toHaveText("Running Iyowa probe");
	const frame = page.frames().find((f) => f.url().includes(`${id}.localhost`));
	if (!frame) throw Error("Missing app frame");
	return frame;
}
test("explicit host bindings accept OS TCP clients and reply to OS UDP datagrams", async ({ page }) => {
	const f = await launch(page);
	const ports = await f.evaluate(async () => {
		const server = new TCPServerSocket("127.0.0.1"),
			udp = new UDPSocket({ localAddress: "::1" }),
			s = await server.opened,
			u = await udp.opened;
		async function echo() {
			const incoming = s.readable.getReader(),
				peer = (await incoming.read()).value as Socket,
				o = await peer.opened,
				reader = o.readable.getReader(),
				writer = o.writable.getWriter();
			await writer.write((await reader.read()).value);
			writer.releaseLock();
			reader.releaseLock();
			await peer.close();
			incoming.releaseLock();
			await server.close();
		}
		async function reply() {
			const r = u.readable.getReader(),
				w = u.writable.getWriter();
			const msg = (await r.read()).value;
			await w.write(msg);
			r.releaseLock();
			w.releaseLock();
			await udp.close();
		}
		void echo();
		void reply();
		return [s.localPort, u.localPort];
	});
	const got = await new Promise<Buffer>((ok, no) => {
		const c = net.connect(ports[0], "127.0.0.1", () => c.write(Buffer.from([4, 0, 255])));
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
test("normal tab loads modules, worker, binary ranges, app-owned service worker and SDK launch", async ({
	page,
}) => {
	const f = await launch(page);
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
	expect(await f.evaluate(async () => await (await fetch("/offline-probe")).text())).toBe(
		"app service worker",
	);
	await page.getByRole("button", { name: "Stop", exact: true }).click();
	await expect(page.locator("main iframe")).toHaveCount(0);
});
test("Scramjet managed frame rewrites JS and fetch, CSS, script results and scoped storage", async ({
	page,
}) => {
	const f = await launch(page);
	const child = f.frameLocator("controlledframe iframe");
	await expect(child.locator("#value")).toHaveText("Bundled JSON");
	expect(
		await f.evaluate(async () => {
			const cf = document.querySelector<CF>("#view");
			if (!cf) throw Error();
			await cf.insertCSS({ code: "h2{color:rgb(10,20,30)}" });
			await cf.executeScript({ code: `localStorage.setItem('probe','managed')` });
			const values = await cf.executeScript({
				code: `[getComputedStyle(document.querySelector('h2')).color,localStorage.getItem('probe')]`,
			});
			await cf.clearData({}, { localStorage: true });
			await cf.setZoom(1.5);
			return [
				values,
				await cf.executeScript({ code: `localStorage.getItem('probe')` }),
				localStorage.getItem("probe"),
				await cf.getZoom(),
			];
		}),
	).toEqual([[["rgb(10, 20, 30)", "managed"]], [null], null, 1.5]);
});
test("virtual TCP accepts, BYOB reads and EOF; bound, connected and multicast UDP", async ({ page }) => {
	const f = await launch(page);
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
				const stream = await c.opened,
					w = stream.writable.getWriter();
				await w.write({ data: new Uint8Array([37]) });
				w.releaseLock();
				const msg = (await r.read()).value;
				datagrams.push(msg.data[0]);
				await c.close();
			}
			r.releaseLock();
			await u.close();
			return [Array.from(value || []), eof.done, datagrams];
		}),
	).toEqual([[0, 254], true, [37, 37]]);
});
test("Wisp v2 returns real echo bytes for the two granted endpoints", async ({ page }) => {
	const f = await launch(page);
	expect(
		await f.evaluate(
			async ([t, u]) => {
				const results = [];
				for (const [s, isUdp] of [
					[new TCPSocket("127.0.0.1", t), false],
					[new UDPSocket({ remoteAddress: "127.0.0.1", remotePort: u }), true],
				] as const) {
					const o = await s.opened,
						w = o.writable.getWriter(),
						r = o.readable.getReader(),
						bytes = new Uint8Array([0, 255, 62]);
					await w.write(isUdp ? { data: bytes } : bytes);
					const got = (await r.read()).value;
					results.push(Array.from(isUdp ? got.data : got));
					w.releaseLock();
					r.releaseLock();
					await s.close();
				}
				return results;
			},
			[tcpPort, udpPort],
		),
	).toEqual([
		[0, 255, 62],
		[0, 255, 62],
	]);
});
test("a dedicated module worker can connect to its window listener", async ({ page }) => {
	const f = await launch(page);
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
			r.releaseLock();
			await s.close();
			const reply = await ack;
			w.terminate();
			return [data.value[0], reply];
		}),
	).toEqual([91, "done"]);
});
test("controlled guest context menu delivers a real click to the embedding app", async ({ page }) => {
	const f = await launch(page),
		child = f.frameLocator("#view iframe");
	await expect(child.locator("#value")).toHaveText("Bundled JSON");
	await f.evaluate(async () => {
		const el = document.querySelector<MenuCF>("#view");
		if (!el) throw Error();
		await el.contextMenus.create({ id: "demo", title: "Selected action", contexts: ["page"] });
		el.contextMenus.addEventListener("click", (e) => {
			el.dataset.click = (e as Event & { menuItemId: string }).menuItemId;
		});
	});
	await child.locator("h2").click({ button: "right" });
	await child.getByRole("menuitem", { name: "Selected action" }).click();
	await expect(f.locator("#view")).toHaveAttribute("data-click", "demo");
});
test("standalone SDK opens protocol launches, delivers launchQueue and preserves app storage", async ({
	page,
}) => {
	await page.goto(host.origin);
	await page.evaluate(async () => {
		const path = "/sdk.js";
		const mod = (await import(path)) as { IwaRuntime: new () => IwaRuntime };
		const r = new mod.IwaRuntime();
		const app = await r.install(await (await fetch("/example.swbn")).blob());
		const target = document.querySelector("main");
		if (!target) throw Error();
		const s = r.launch(app, target);
		Reflect.set(window, "testSession", s);
		await s.ready;
	});
	const view = page.frameLocator("main iframe");
	await expect(view.locator("#result")).toContainText("worker function");
	const f = page.frames().find((f) => f.url().includes(id));
	if (!f) throw Error();
	await f.evaluate(() => localStorage.setItem("note", "remember"));
	await page.evaluate(() => {
		(Reflect.get(window, "testSession") as IwaSession).openProtocol("lab://open/note");
	});
	await expect.poll(() => f.url()).toContain("lab%3A%2F%2Fopen%2Fnote");
	await expect(view.locator("#result")).toContainText("worker function");
	expect(await f.evaluate(() => localStorage.getItem("note"))).toBe("remember");
	await f.evaluate(() => {
		(
			Reflect.get(window, "launchQueue") as {
				setConsumer(cb: (l: { targetURL: string }) => void): void;
			}
		).setConsumer((l) => {
			document.body.dataset.lastLaunch = l.targetURL;
		});
	});
	await page.evaluate(() => {
		(Reflect.get(window, "testSession") as IwaSession).deliverLaunch("lab://second");
	});
	await expect(view.locator("body")).toHaveAttribute("data-last-launch", "lab://second");
});
test("managed partner origin, resource interception, partition history", async ({ page }) => {
	const f = await launch(page);
	await expect(f.frameLocator("#view iframe").locator("#value")).toHaveText("Bundled JSON");
	expect(
		await f.evaluate(async (origin) => {
			const cf = document.querySelector<ManagedCF>("#view");
			if (!cf) throw Error();
			await cf.executeScript({ code: `localStorage.setItem('marker','package')` });
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
				const evt = e as Event & { headers: Headers; setRequestHeaders(h: Headers): void };
				evt.headers.set("X-Probe", "header received");
				evt.setRequestHeaders(evt.headers);
			});
			const value = await cf.executeScript({
				code: `Promise.all([document.title,localStorage.getItem('marker'),fetch('/echo').then(r=>r.text()),fetch('/block').then(r=>r.status)])`,
			});
			const prior = new Promise((ok) => cf.addEventListener("loadstop", ok, { once: true }));
			await cf.back();
			await prior;
			return [value, await cf.executeScript({ code: `localStorage.getItem('marker')` })];
		}, siteOrigin),
	).toEqual([[["Partner site", null, "header received", 403]], ["package"]]);
});
test("non-granted capabilities and unwanted update identities fail", async ({ page }) => {
	const no = await fixture(
		{ permissions_policy: {}, version: "2.0.0" },
		(await import("node:crypto")).generateKeyPairSync("ed25519").privateKey,
	);
	await page.goto(host.origin);
	await page.locator("#file").setInputFiles({
		name: "policy.swbn",
		mimeType: "application/octet-stream",
		buffer: Buffer.from(no),
	});
	await expect(page.locator("output")).toHaveText("Running Iyowa probe");
	const a: AppInfo = host.list().find((x) => x.version === "2.0.0") as AppInfo;
	const f = page.frames().find((f) => f.url().startsWith(a.appOrigin));
	if (!f) throw Error();
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
});
