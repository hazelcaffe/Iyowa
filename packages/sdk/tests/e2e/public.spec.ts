import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import { PUBLIC_DIR } from "../../scripts/public.ts";
import { launch, prompts, startHost } from "./helpers.ts";

// Pinned, unmodified upstream IWAs (`pnpm test:public` downloads and verifies them first).
test.skip(!process.env.PUBLIC_IWAS, "Run `pnpm test:public` to fetch the pinned upstream bundles");
test.use({
	launchOptions: {
		args: [
			"--use-fake-device-for-media-stream",
			"--use-fake-ui-for-media-stream",
			"--auto-select-desktop-capture-source=Entire screen",
		],
	},
});

let host: Awaited<ReturnType<typeof startHost>>;
const ids: Record<string, string> = {};
test.beforeAll(async () => {
	host = await startHost();
	for (const name of ["kitchen-sink", "iwa-windowing-example", "iwa-bundling-example"])
		ids[name] = (await host.install(await readFile(`${PUBLIC_DIR}${name}.swbn`))).id;
});
test.afterAll(async () => {
	await host?.cleanup();
});
test.beforeEach(async () => {
	for (const id of Object.values(ids)) await host.setPermission(id, "local-network", "prompt");
});

const sink = () => ids["kitchen-sink"] as string;
const socketRoutes = (page: Page) =>
	page.evaluate(() =>
		[
			...(
				window as unknown as {
					iyowa: { session: { sockets: Map<string, { kind: string; route: string }> } };
				}
			).iyowa.session.sockets.values(),
		].map((s) => `${s.kind}:${s.route}`),
	);

test("IWA Bundling Example starts", async ({ page }) => {
	const f = await launch(page, host, ids["iwa-bundling-example"] as string);
	await expect(f.getByRole("heading", { name: "IWA Bundling Example", exact: true })).toBeVisible();
	expect(await f.evaluate(() => crossOriginIsolated)).toBe(true);
});

test("IWA Windowing Example: borderless display mode and in-tab popups", async ({ page }) => {
	const f = await launch(page, host, ids["iwa-windowing-example"] as string);
	await expect(f.locator(".displaymode-borderless")).toBeVisible();
	await expect(f.locator(".displaymode-browser")).toBeHidden();
	await f.locator("#openWindowButton").click();
	const popup = f.getByRole("dialog");
	await expect(
		popup.frameLocator("iframe").getByRole("heading", { name: "IWA Windowing Example", exact: true }),
	).toBeVisible();
	await expect(f.locator("#log")).toContainText("Opened popup #1");
	await popup.locator("iframe").evaluate((frame) => (frame as HTMLIFrameElement).contentWindow?.close());
	await expect(popup).toHaveCount(0);
	await expect(f.locator("#log")).toContainText("Popup #1 closed");
});

for (const answer of ["denied", "granted"] as const)
	test(`Kitchen Sink sockets: TCPServerSocket and TCPSocket exchange messages (local network ${answer})`, async ({
		page,
	}) => {
		const f = await launch(page, host, sink(), { answer });
		await f.locator("#addSocketButton").click();
		const connection = f.locator("socket-connection");
		await expect(connection.locator("#connection")).toContainText("Successfully connected");
		await connection.locator("#messageInput").fill("hello Kitchen Sink");
		await connection.locator("#sendButton").click();
		await expect(f.locator("socket-server")).toHaveAttribute("log", "hello Kitchen Sink");
		await f.locator("socket-server #messageInput").fill("ack");
		await f.locator("socket-server #sendButton").click();
		await expect(connection).toHaveAttribute("log", "ack");
		expect((await prompts(page)).map((p) => p.name)).toContain("local-network");
		// Blocked: both ends live in the app's in-tab loopback. Allowed: a real port, reached through the relay.
		expect(await socketRoutes(page)).toEqual(
			answer === "granted"
				? expect.arrayContaining(["tcp-server:system", "tcp:network"])
				: expect.arrayContaining(["tcp-server:in-app", "tcp:in-app"]),
		);
	});

test("Kitchen Sink screen capture: getAllScreensMedia returns a live stream", async ({ page }) => {
	const f = await launch(page, host, sink(), { path: "/screencapture.html" });
	await f.getByRole("button", { name: "Capture the screens" }).click();
	const video = f.locator("#capture-container video");
	await expect(video).toHaveCount(1);
	await expect.poll(() => video.evaluate((v) => (v as HTMLVideoElement).videoWidth)).toBeGreaterThan(0);
	expect(
		await video.evaluate((v) => {
			const stream = (v as HTMLVideoElement).srcObject as MediaStream;
			const state = stream.getVideoTracks()[0]?.readyState;
			for (const t of stream.getTracks()) t.stop();
			return state;
		}),
	).toBe("live");
});

test("Kitchen Sink unframed mode follows the window-management grant", async ({ page, context }) => {
	const f = await launch(page, host, sink());
	const go = f.getByRole("button", { name: "Go unframed" });
	await expect(go).toBeVisible();
	await go.evaluate((el) => {
		matchMedia("(display-mode: unframed)").addEventListener("change", (e) => {
			el.setAttribute("data-transition", String(e.matches));
		});
	});
	// Click first so Chromium sees real user activation, then grant the pending permission.
	await go.click();
	const devtools = await context.newCDPSession(page);
	const {
		targetInfo: { browserContextId },
	} = await devtools.send("Target.getTargetInfo");
	await devtools.send("Browser.setPermission", {
		permission: { name: "window-management" },
		setting: "granted",
		origin: host.origin,
		embeddedOrigin: new URL(f.url()).origin,
		browserContextId,
	});
	await expect(f.locator("#border")).toBeVisible();
	await expect(f.locator("#unframed")).toBeHidden();
	await expect(f.locator("#unframed")).toHaveAttribute("data-transition", "true");
});

test("Kitchen Sink controlled frame: live Google page in a proxied frame, driven by the app", async ({
	page,
}) => {
	const f = await launch(page, host, sink(), { path: "/cf.html" });
	const guest = f.frameLocator("#cf iframe");
	const lucky = guest.locator('[aria-label="I\'m Feeling Lucky"]').first();
	await lucky.waitFor({ state: "attached", timeout: 30000 });
	// The guest is a Scramjet document on the partition origin, never a native cross-origin frame.
	expect(new URL((await f.locator("#cf iframe").getAttribute("src")) ?? "").hostname).toMatch(
		/^p-[0-9a-f]{40}\.localhost$/,
	);
	await f.locator("#lucky").fill("Curious");
	await f.locator("#lucky").press("Tab");
	await expect(lucky).toHaveAttribute("value", "I'm Feeling Curious");
	await f.locator("#color").evaluate((el: HTMLInputElement) => {
		el.value = "#00ff00";
		el.dispatchEvent(new Event("change", { bubbles: true }));
	});
	await expect(guest.locator("body")).toHaveCSS("background-color", "rgb(0, 255, 0)");
	expect(
		await f.locator("#cf").evaluate((cf) =>
			(cf as HTMLElement & { executeScript(o: object): Promise<unknown[]> }).executeScript({
				code: "location.hostname",
			}),
		),
	).toEqual(["www.google.com"]);
});

test("Kitchen Sink OAuth: loopback redirect reaches the app's TCPServerSocket", async ({ context, page }) => {
	let exchanged = false;
	await context.route("https://issuer.iyowa.test/**", async (route) => {
		const u = new URL(route.request().url());
		if (u.pathname === "/authorize") {
			const callback = new URL(u.searchParams.get("redirect_uri") || "");
			callback.searchParams.set("state", u.searchParams.get("state") || "");
			callback.searchParams.set("code", "fixture-code");
			await route.fulfill({
				contentType: "text/html",
				body: `<a href="${callback.href.replaceAll("&", "&amp;")}">Approve test grant</a>`,
			});
			return;
		}
		exchanged = u.searchParams.get("code") === "fixture-code" && route.request().method() === "POST";
		await route.fulfill({
			headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
			body: JSON.stringify({ access_token: "fixture-token" }),
		});
	});
	const f = await launch(page, host, sink(), { path: "/oauth.html", answer: "granted" });
	await f.locator("#auth-endpoint").fill("https://issuer.iyowa.test/authorize");
	await f.locator("#access-endpoint").fill("https://issuer.iyowa.test/token");
	await f.locator("#client-id").fill("test-client");
	await f.locator("#scope").fill("test");
	const opened = context.waitForEvent("page");
	await f.locator("#oauth-flow").click();
	const provider = await opened;
	await provider.getByRole("link", { name: "Approve test grant" }).click();
	await expect(provider.locator("h1")).toBeVisible();
	await expect(f.locator("#access-code")).toHaveText("fixture-token");
	await expect(f.locator("#auth-token")).toHaveText("fixture-code");
	expect(exchanged).toBe(true);
});

test("installing from a public update manifest picks the release and runs it", async ({ page }) => {
	await page.goto(host.origin);
	await page.waitForFunction(() => document.title === "ready");
	const app = await page.evaluate(
		(url) =>
			(
				window as unknown as {
					iyowa: { runtime: { installURL(u: string): Promise<{ id: string; version: string }> } };
				}
			).iyowa.runtime.installURL(url),
		"https://github.com/chromeos/iwa-sink/releases/download/v1.7.0/update.json",
	);
	expect(app).toMatchObject({ id: sink(), version: "1.7.0" });
});

test("legacy Kitchen Sink (pre-standard `controlledframe` policy) still gets controlled frames", async ({
	page,
}) => {
	const legacy = await startHost();
	try {
		const { id } = await legacy.install(await readFile(`${PUBLIC_DIR}kitchen-sink-legacy.swbn`));
		const f = await launch(page, legacy, id, { path: "/cf.html" });
		await expect(f.locator("#cf iframe")).toHaveAttribute("src", /p-[0-9a-f]{40}\.localhost/, {
			timeout: 15000,
		});
	} finally {
		await legacy.cleanup();
	}
});
