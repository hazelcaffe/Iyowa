import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHost, type IyowaHost } from "@iyowa/sdk/host";
import { expect, test } from "@playwright/test";

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

test("install an example, answer its permission prompt, inspect it, then remove it", async ({ page }) => {
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await page.goto(host.origin);
	await expect(page.getByRole("heading", { name: "Library" })).toBeVisible();
	await expect(page.getByText("No apps yet")).toBeVisible();

	const example = page.getByRole("listitem").filter({ hasText: "Socket Lab" });
	await example.getByRole("button", { name: "Install" }).click();
	await expect(page.getByRole("status").filter({ hasText: "Installed Socket Lab 1.0.0" })).toBeVisible();

	// Installing opens the app in the shell.
	const toolbar = page.locator(".app-toolbar");
	await expect(toolbar).toContainText("Socket Lab");
	await expect(page).toHaveURL(/#\/app\/[a-z2-7]+$/);
	const app = page.frameLocator(".surface iframe");

	// A listener asks for local network access; blocking keeps it inside the app.
	await app.getByRole("button", { name: "Listen on 127.0.0.1" }).click();
	const prompt = page.getByRole("alertdialog");
	await expect(prompt).toContainText("Socket Lab wants to access devices on your local network");
	await expect(page.getByRole("navigation").locator(".dot.attention")).toBeVisible();
	await prompt.getByRole("button", { name: "Block" }).click();
	await expect(prompt).toBeHidden();
	await expect(app.locator("#server")).toContainText("Echoing on 127.0.0.1:");

	// Developer tools: socket table and console.
	await page.getByRole("button", { name: "Developer tools" }).click();
	const devtools = page.getByRole("region", { name: "Developer tools" });
	await devtools.getByRole("tab", { name: /Sockets/ }).click();
	const row = devtools.getByRole("row").filter({ hasText: "TCP server" });
	await expect(row).toContainText("in-app");
	await expect(row).toContainText("open");
	await devtools.getByRole("tab", { name: /Console/ }).click();
	await page
		.frames()
		.find((f) => f.url().includes(".localhost:") && !f.url().startsWith(host.origin))
		?.evaluate(() => console.warn("hello devtools"));
	await expect(devtools.getByRole("listitem").filter({ hasText: "hello devtools" })).toHaveClass(/warn/);
	await devtools.getByRole("tab", { name: /Permissions/ }).click();
	await expect(devtools.getByRole("combobox", { name: "Local network access" })).toHaveValue("denied");

	// Reloading the launcher restores the open app from the URL.
	await page.reload();
	await expect(toolbar).toContainText("Socket Lab");
	await expect(app.getByRole("button", { name: "Connect" })).toBeVisible();

	// Details: identity, then remove.
	await page.getByRole("button", { name: "App info" }).click();
	const details = page.getByRole("dialog", { name: "Socket Lab" });
	await expect(details).toContainText("signature verified");
	await details.getByRole("button", { name: "Remove" }).click();
	await details.getByRole("button", { name: "Remove" }).click();
	await expect(details).toBeHidden();
	await expect(page.getByRole("heading", { name: "Library" })).toBeVisible();
	await expect(page.getByText("No apps yet")).toBeVisible();
	expect(host.list()).toEqual([]);
	expect(errors).toEqual([]);
});

test("choosing a bundle file installs and opens it; bad files are rejected", async ({ page }) => {
	await page.goto(host.origin);
	const input = page.getByLabel("Signed web bundle");
	await input.setInputFiles({
		name: "broken.swbn",
		mimeType: "application/octet-stream",
		buffer: Buffer.from("not a bundle"),
	});
	await expect(page.getByRole("alert")).toBeVisible();
	expect(host.list()).toEqual([]);

	const bytes = await (await fetch(`${host.origin}/examples/controlled-frame-lab.swbn`)).arrayBuffer();
	await input.setInputFiles({
		name: "lab.swbn",
		mimeType: "application/octet-stream",
		buffer: Buffer.from(bytes),
	});
	const app = page.frameLocator(".surface iframe");
	// The lab's bundled start page renders through the controlled-frame proxy.
	await expect(
		app.frameLocator("controlledframe iframe").getByRole("heading", { name: "Hello from the bundle" }),
	).toBeVisible({
		timeout: 20000,
	});
	await page.getByRole("button", { name: "Library", exact: true }).click();
	const card = page
		.getByRole("region", { name: "Installed" })
		.getByRole("listitem")
		.filter({ hasText: "Controlled Frame Lab" });
	await expect(card).toContainText("Running");
	await expect(card).toContainText("Controlled Frame");
	// Installed examples leave the "Try an app" list.
	await expect(page.getByRole("region", { name: "Try an app" })).not.toContainText("Controlled Frame Lab");
});
