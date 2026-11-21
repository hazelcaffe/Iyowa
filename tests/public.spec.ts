import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { createHost } from "../host/index.ts";

test.skip(!process.env.PUBLIC_IWAS, "Run pnpm test:public to fetch pinned upstream artifacts");
let host: Awaited<ReturnType<typeof createHost>>, dir: string;
test.beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "iyowa-public-"));
	host = await createHost({ port: 0, dataDir: dir });
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
test("URL input resolves public update manifest and launches selected release", async ({ page }) => {
	await page.goto(host.origin);
	await page
		.getByRole("textbox")
		.fill("https://github.com/chromeos/iwa-sink/releases/download/v1.7.0/update.json");
	await page.getByRole("button", { name: "Load URL" }).click();
	await expect(page.locator("output")).toHaveText("Running Kitchen Sink IWA", { timeout: 20000 });
});
