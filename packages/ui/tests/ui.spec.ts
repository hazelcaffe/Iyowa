import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHost, type IyowaHost } from "@iyowa/sdk/host";
import { expect, type Page, test } from "@playwright/test";

// The production launcher (packages/ui/dist) on a fresh, empty library.
let host: IyowaHost;
let dir: string;
test.beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "iyowa-ui-"));
	host = await createHost({
		port: 0,
		dataDir: dir,
		ui: { dir: fileURLToPath(new URL("../dist/", import.meta.url)) },
	});
});
test.afterEach(async () => {
	await host.close();
	await rm(dir, { recursive: true, force: true });
});

const installExample = async (page: Page, name: string) => {
	await page.getByRole("button", { name: "Install", exact: true }).click();
	await page.getByRole("menuitem", { name }).click();
};
const status = (page: Page) => page.locator("#runtime-state");
const visibleApp = (page: Page) => page.frameLocator(".surface:not([hidden]) iframe");

test("install and run an example, answer its permission request, inspect logs and sockets, then remove it", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await page.goto(host.origin);
	await expect(page.getByRole("heading", { name: "Run an Isolated Web App" })).toBeVisible();
	await expect(status(page)).toHaveText("Runtime ready");
	await expect(page.getByRole("combobox", { name: "App" })).toBeDisabled();

	await installExample(page, "Socket Lab");
	await expect(page.getByRole("alert").filter({ hasText: "Socket Lab 1.0.1" })).toBeVisible();
	await expect(status(page)).toHaveText("App running");
	await expect(page.getByRole("combobox", { name: "App" })).toHaveValue(/^[a-z2-7]+$/);
	await expect(page.getByRole("heading", { name: "Run an Isolated Web App" })).toBeHidden();

	// A listener asks for local network access; blocking keeps it inside the app.
	const app = visibleApp(page);
	await app.getByRole("button", { name: "Listen on 127.0.0.1" }).click();
	const request = page.locator("#permission-request");
	await expect(request).toContainText(
		"Socket Lab wants to access your local network to accept connections on 127.0.0.1",
	);
	await request.getByRole("button", { name: "Block" }).click();
	await expect(request).toBeHidden();
	await expect(app.locator("#server")).toContainText("Echoing on 127.0.0.1:");

	// Sockets panel: the listener stayed in-app.
	await page.getByRole("button", { name: /^Sockets/ }).click();
	const sockets = page.getByRole("region", { name: "Sockets" });
	const row = sockets.getByRole("row").filter({ hasText: "TCP server" });
	await expect(row).toContainText("in-app");
	await expect(row).toContainText("open");

	// Logs panel: runtime events, the app's console and socket activity.
	await page
		.frames()
		.find((f) => /^http:\/\/[a-z2-7]+\.localhost:/.test(f.url()))
		?.evaluate(() => console.warn("hello logs"));
	await page.getByRole("button", { name: /^Logs/ }).click();
	const log = page.getByRole("log", { name: "Runtime and app output" });
	await expect(log.locator(".log.warn")).toContainText("hello logs");
	await expect(log).toContainText("Blocked local network access for Socket Lab");
	await expect(log).toContainText("TCP server 127.0.0.1:");
	await page.keyboard.press("Control+`");
	await expect(log).toBeHidden();

	// Settings remember the answer.
	await page.getByRole("button", { name: "Settings" }).click();
	const settings = page.getByRole("dialog", { name: "Settings" });
	await expect(settings.getByRole("combobox", { name: "Local network access" })).toHaveValue("denied");
	await expect(settings).toContainText("signature verified");

	// A second app gets a tab; tabs switch the visible app.
	await page.keyboard.press("Escape");
	await installExample(page, "Controlled Frame Lab");
	const tabs = page.getByRole("tablist", { name: "Running apps" });
	await expect(tabs.getByRole("tab")).toHaveCount(2);
	await expect(tabs.getByRole("tab", { selected: true })).toContainText("Controlled Frame Lab");
	await tabs.getByRole("tab", { name: /Socket Lab/ }).click();
	await expect(visibleApp(page).getByRole("button", { name: "Listen on 127.0.0.1" })).toBeVisible();

	// Stop one; remove the other.
	await page.getByRole("button", { name: "Stop" }).click();
	await expect(tabs).toBeHidden();
	await page.getByRole("button", { name: "Settings" }).click();
	await settings.getByRole("button", { name: "Remove app" }).click();
	await settings.getByRole("button", { name: "Remove app" }).click();
	await expect(settings).toBeHidden();
	await expect.poll(() => host.list().length).toBe(1);
	expect(errors).toEqual([]);
});

test("choosing a bundle file installs and runs it; bad files are reported", async ({ page }) => {
	await page.goto(host.origin);
	const input = page.getByLabel("Signed web bundle");
	await input.setInputFiles({
		name: "broken.swbn",
		mimeType: "application/octet-stream",
		buffer: Buffer.from("not a bundle"),
	});
	await expect(page.getByRole("alert").filter({ hasText: "Install failed" })).toBeVisible();
	expect(host.list()).toEqual([]);

	const bytes = await (await fetch(`${host.origin}/examples/controlled-frame-lab.swbn`)).arrayBuffer();
	await input.setInputFiles({
		name: "lab.swbn",
		mimeType: "application/octet-stream",
		buffer: Buffer.from(bytes),
	});
	// The lab's bundled start page renders through the controlled-frame proxy.
	await expect(
		visibleApp(page)
			.frameLocator("controlledframe iframe")
			.getByRole("heading", { name: "Hello from the bundle" }),
	).toBeVisible({ timeout: 20000 });

	// Run restarts the app; Stop returns to the home screen with the app still selected.
	await page.getByRole("button", { name: "Run" }).click();
	await expect(status(page)).toHaveText("App running");
	await page.getByRole("button", { name: "Stop" }).click();
	await expect(page.getByRole("heading", { name: "Run an Isolated Web App" })).toBeVisible();
	await expect(page.getByRole("combobox", { name: "App" }).locator("option:checked")).toHaveText(
		"Controlled Frame Lab 1.0.1",
	);
});
