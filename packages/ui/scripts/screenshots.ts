import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHost } from "@iyowa/sdk/host";
import { type Browser, chromium, type Page } from "@playwright/test";

// Regenerates docs/assets/*.png from the production launcher (run `pnpm build` and
// `node packages/sdk/scripts/public.ts` first). Pages with live sites need network access.
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const out = here("../../../docs/assets/");
const publicDir = here("../../../.cache/public/");
const examples = here("../../sdk/dist/examples/");

const data = await mkdtemp(join(tmpdir(), "iyowa-screens-"));
const host = await createHost({ port: 0, dataDir: data, ui: { dir: here("../dist") } });
const ids: Record<string, string> = {};
for (const [name, file] of [
	["socket-lab", `${examples}socket-lab.swbn`],
	["frame-lab", `${examples}controlled-frame-lab.swbn`],
	["windowing", `${publicDir}iwa-windowing-example.swbn`],
	["kitchen-sink", `${publicDir}kitchen-sink.swbn`],
] as const)
	ids[name] = (await host.install(await readFile(file))).id;
await host.setPermission(ids["kitchen-sink"] as string, "local-network", "granted");
await mkdir(out, { recursive: true });

const viewport = { width: 1440, height: 900 };
const browser: Browser = await chromium.launch();
const shoot = (page: Page, name: string) => page.screenshot({ path: `${out}${name}.png` });
const visible = (page: Page) => page.frameLocator(".surface:not([hidden]) iframe");
async function run(page: Page, id: string) {
	await page.getByRole("combobox", { name: "App" }).selectOption(id);
	await page.getByRole("button", { name: "Run" }).click();
	await page.locator("#runtime-state").getByText("App running").waitFor({ timeout: 20000 });
}
async function quiet(page: Page) {
	for (const close of await page.getByRole("button", { name: /^Close notification|^Close$/ }).all())
		await close.click().catch(() => {});
	await page
		.locator(".mantine-Notification-root")
		.first()
		.waitFor({ state: "detached" })
		.catch(() => {});
}

try {
	for (const colorScheme of ["light", "dark"] as const) {
		const page = await browser.newPage({ viewport, colorScheme });
		await page.goto(host.origin);
		await page.getByRole("heading", { name: "Run an Isolated Web App" }).waitFor();
		await shoot(page, colorScheme === "light" ? "home" : "home-dark");

		// Three running apps; Kitchen Sink's controlled frame shows a live site inside the app.
		await run(page, ids["socket-lab"] as string);
		await run(page, ids["frame-lab"] as string);
		await run(page, ids["kitchen-sink"] as string);
		await visible(page).getByRole("link", { name: "controlled frame" }).click();
		await visible(page).frameLocator("#cf iframe").locator("body").waitFor();
		await page.waitForTimeout(4000);
		await quiet(page);
		await shoot(page, colorScheme === "light" ? "app" : "app-dark");
		await page.close();
	}

	// A local network request, answered inline like Neutron's device requests.
	{
		const page = await browser.newPage({ viewport });
		await page.goto(host.origin);
		await run(page, ids["socket-lab"] as string);
		await visible(page).getByRole("button", { name: "Listen on 127.0.0.1" }).click();
		await page.locator("#permission-request").waitFor();
		await quiet(page);
		await shoot(page, "permission-prompt");
		await page.getByRole("button", { name: "Block" }).click();

		// Raw TCP and UDP from the app, with the Sockets panel.
		await visible(page).locator("#preset").selectOption({ label: "HTTP GET example.com" });
		await visible(page).locator("#tcp").getByText("connection closed").waitFor({ timeout: 20000 });
		await visible(page).getByRole("button", { name: "Resolve via 1.1.1.1" }).click();
		await visible(page).locator("#misc").getByText("udp:").waitFor({ timeout: 10000 });
		await page.getByRole("button", { name: /^Sockets/ }).click();
		await quiet(page);
		await shoot(page, "sockets");

		// The Logs panel: runtime events, app consoles and socket activity.
		await page.getByRole("button", { name: /^Logs/ }).click();
		await shoot(page, "logs");

		await page.getByRole("button", { name: /^Logs/ }).click();
		await page.getByRole("button", { name: "Settings" }).click();
		await page.getByRole("dialog", { name: "Settings" }).waitFor();
		await page.waitForTimeout(400);
		await shoot(page, "settings");
		await page.close();
	}
	console.log(`Wrote screenshots to ${out}`);
} finally {
	await browser.close();
	await host.close();
	await rm(data, { recursive: true, force: true });
}
