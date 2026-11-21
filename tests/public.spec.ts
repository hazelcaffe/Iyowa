import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { createHost } from "../host/index.ts";
import { readBundle } from "../runtime/bundle.ts";

test.skip(!process.env.PUBLIC_IWAS, "Run pnpm test:public to fetch pinned upstream artifacts");
test.use({
	launchOptions: {
		args: [
			"--use-fake-device-for-media-stream",
			"--use-fake-ui-for-media-stream",
			"--auto-select-desktop-capture-source=Entire screen",
		],
	},
});
let host: Awaited<ReturnType<typeof createHost>>, dir: string;
test.beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "iyowa-public-"));
	const sink = readBundle(await readFile(".cache/public/kitchen-sink.swbn"));
	host = await createHost({
		port: 0,
		dataDir: dir,
		bindings: [{ id: sink.id, protocol: "tcp", address: "127.0.0.1", port: 0 }],
	});
});
test.afterAll(async () => {
	await host?.close();
	if (dir) await rm(dir, { recursive: true, force: true });
});
for (const [name, heading] of [
	["iwa-bundling-example", "IWA Bundling Example"],
	["iwa-windowing-example", "IWA Windowing Example"],
	["kitchen-sink", "Kitchen Sink IWA"],
])
	test(name, async ({ page }) => {
		await page.goto(host.origin);
		await page.locator("#file").setInputFiles(`.cache/public/${name}.swbn`);
		await expect(page.locator("output")).toHaveText(`Running ${heading}`);
		const f = page.frameLocator("main iframe");
		if (name !== "kitchen-sink") {
			await expect(f.getByRole("heading", { name: heading, exact: true })).toBeVisible();
			if (name === "iwa-windowing-example") {
				await expect(f.locator(".displaymode-borderless")).toBeVisible();
				await expect(f.locator(".displaymode-browser")).toBeHidden();
				await f.locator("#openWindowButton").click();
				const popup = f.getByRole("dialog");
				await expect(
					popup.frameLocator("iframe").getByRole("heading", { name: heading, exact: true }),
				).toBeVisible();
				await expect(f.locator("#log")).toContainText("Opened popup #1");
				await popup
					.locator("iframe")
					.evaluate((frame) => (frame as HTMLIFrameElement).contentWindow?.close());
				await expect(popup).toHaveCount(0);
				await expect(f.locator("#log")).toContainText("Popup #1 closed");
			}
			return;
		}
		await f.locator("#addSocketButton").click();
		const c = f.locator("socket-connection");
		await expect(c.locator("#connection")).toContainText("Successfully connected");
		await c.locator("#messageInput").fill("hello Kitchen Sink");
		await c.locator("#sendButton").click();
		await expect(f.locator("socket-server")).toHaveAttribute("log", "hello Kitchen Sink");
		await f.locator("socket-server #messageInput").fill("ack");
		await f.locator("socket-server #sendButton").click();
		await expect(c).toHaveAttribute("log", "ack");
	});
test.describe("Kitchen Sink screen APIs", () => {
	test("share picker returns a stream the capture page can actually play", async ({ page }) => {
		await page.goto(host.origin);
		await page.locator("#file").setInputFiles(".cache/public/kitchen-sink.swbn");
		const app = page.frameLocator("main iframe");
		await app.getByRole("link", { name: "Screen capture" }).click();
		await app.getByRole("button", { name: "Capture the screens" }).click();
		const video = app.locator("#capture-container video");
		await expect(video).toHaveCount(1);
		await expect.poll(() => video.evaluate((v) => (v as HTMLVideoElement).videoWidth)).toBeGreaterThan(0);
		expect(
			await video.evaluate((v) => {
				const stream = (v as HTMLVideoElement).srcObject as MediaStream;
				const live = stream.getVideoTracks()[0]?.readyState;
				for (const t of stream.getTracks()) t.stop();
				return live;
			}),
		).toBe("live");
	});
});
test("Kitchen Sink unframed inline CSS and existing media listeners follow the actual grant", async ({
	page,
	context,
}) => {
	await page.goto(host.origin);
	await page.locator("#file").setInputFiles(".cache/public/kitchen-sink.swbn");
	const app = page.frameLocator("main iframe");
	const go = app.getByRole("button", { name: "Go unframed" });
	await expect(go).toBeVisible();
	await go.evaluate((el) => {
		const m = matchMedia("(display-mode: unframed)");
		m.addEventListener("change", (e) => {
			el.setAttribute("data-transition", String(e.matches));
		});
	});
	// Click first so Chromium sees the real user activation, then grant the pending permission.
	await go.click();
	const frame = page.frames().find((f) => f.url().includes(".localhost:"));
	if (!frame) throw Error("Missing IWA");
	const devtools = await context.newCDPSession(page);
	const {
		targetInfo: { browserContextId },
	} = await devtools.send("Target.getTargetInfo");
	await devtools.send("Browser.setPermission", {
		permission: { name: "window-management" },
		setting: "granted",
		origin: host.origin,
		embeddedOrigin: new URL(frame.url()).origin,
		browserContextId,
	});
	await expect(app.locator("#border")).toBeVisible();
	await expect(app.locator("#unframed")).toBeHidden();
	await expect(app.locator("#unframed")).toHaveAttribute("data-transition", "true");
});
test("Kitchen Sink remote controlled frame uses the Scramjet transport", async ({ page, context }) => {
	// Stand in for an embedding-enabled publisher. Exercise the exact upstream app controls;
	// do not depend on a live search service or its frequently changing HTML for this check.
	let sources = 0;
	await context.route("**/.iyowa/upstream?*", async (route) => {
		sources++;
		await route.fulfill({
			status: 200,
			headers: { "X-Iyowa-Status": "200", "X-Iyowa-Type": "text/html" },
			body: `<!doctype html><title>Fixture</title><input aria-label="I'm Feeling Lucky" value="Lucky">`,
		});
	});
	await page.goto(host.origin);
	await page.locator("#file").setInputFiles(".cache/public/kitchen-sink.swbn");
	const app = page.frameLocator("main iframe");
	await app.getByRole("link", { name: "Controlled Frame" }).click();
	const guest = app.frameLocator("#cf iframe");
	await expect(guest.getByRole("textbox")).toHaveValue("Lucky");
	await app.locator("#lucky").fill("Ready");
	await app.locator("#lucky").press("Tab");
	await expect(guest.getByRole("textbox")).toHaveValue("I'm Feeling Ready");
	await app.locator("#color").fill("#ff0000");
	await expect(guest.locator("body")).toHaveCSS("background-color", "rgb(255, 0, 0)");
	expect(sources).toBeGreaterThan(0);
});
test("Kitchen Sink OAuth completes a loopback callback against a test provider", async ({
	context,
	page,
}) => {
	let sawToken = false;
	await context.route("https://issuer.iyowa.test/**", async (r) => {
		const u = new URL(r.request().url());
		if (u.pathname === "/authorize") {
			const cb = new URL(u.searchParams.get("redirect_uri") || "");
			expect(cb.hostname).toBe("localhost");
			cb.searchParams.set("state", u.searchParams.get("state") || "");
			cb.searchParams.set("code", "fixture-code");
			await r.fulfill({
				status: 200,
				contentType: "text/html",
				body: `<a href="${cb.href.replaceAll("&", "&amp;")}">Approve test grant</a>`,
			});
		} else {
			sawToken = u.searchParams.get("code") === "fixture-code" && r.request().method() === "POST";
			await r.fulfill({
				status: 200,
				headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
				body: JSON.stringify({ access_token: "fixture-token" }),
			});
		}
	});
	await page.goto(host.origin);
	await page.locator("#file").setInputFiles(".cache/public/kitchen-sink.swbn");
	const app = page.frameLocator("main iframe");
	await app.getByRole("link", { name: "OAuth flow" }).click();
	await app.locator("#auth-endpoint").fill("https://issuer.iyowa.test/authorize");
	await app.locator("#access-endpoint").fill("https://issuer.iyowa.test/token");
	await app.locator("#client-id").fill("test-client");
	await app.locator("#scope").fill("test");
	const opened = context.waitForEvent("page");
	await app.locator("#oauth-flow").click();
	const provider = await opened;
	await provider.getByRole("link", { name: "Approve test grant" }).click();
	await expect(app.locator("#access-code")).toHaveText("fixture-token");
	await expect(app.locator("#auth-token")).toHaveText("fixture-code");
	expect(sawToken).toBe(true);
});
test("URL input resolves public update manifest and launches selected release", async ({ page }) => {
	await page.goto(host.origin);
	await page
		.getByRole("textbox")
		.fill("https://github.com/chromeos/iwa-sink/releases/download/v1.7.0/update.json");
	await page.getByRole("button", { name: "Load URL" }).click();
	await expect(page.locator("output")).toHaveText("Running Kitchen Sink IWA", { timeout: 20000 });
});
