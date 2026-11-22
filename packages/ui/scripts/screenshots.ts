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
for (const file of [`${examples}socket-lab.swbn`, `${examples}controlled-frame-lab.swbn`])
	await host.install(await readFile(file));
for (const name of ["iwa-bundling-example", "iwa-windowing-example", "kitchen-sink"])
	await host.install(await readFile(`${publicDir}${name}.swbn`));
await mkdir(out, { recursive: true });

const viewport = { width: 1440, height: 900 };
const browser: Browser = await chromium.launch();
const shoot = (page: Page, name: string) => page.screenshot({ path: `${out}${name}.png` });
const open = async (page: Page, name: string) => {
	await page.getByRole("button", { name: `Open ${name}` }).click();
	await page.locator(".app-toolbar").getByText(name).first().waitFor();
};

try {
	for (const colorScheme of ["light", "dark"] as const) {
		const page = await browser.newPage({ viewport, colorScheme });
		await page.goto(host.origin);
		await page.locator(".app-card").first().waitFor();
		await page.evaluate(() => localStorage.setItem("iyowa:devtools", "closed"));
		await shoot(page, colorScheme === "light" ? "library" : "library-dark");
		await page.close();
	}

	// Kitchen Sink's controlled-frame page, with the live site inside the app.
	{
		const page = await browser.newPage({ viewport });
		await page.goto(`${host.origin}/#/`);
		await open(page, "Kitchen Sink IWA");
		const prompt = page.getByRole("alertdialog");
		await prompt.waitFor();
		await shoot(page, "permission-prompt");
		await prompt.getByRole("button", { name: "Allow" }).click();
		const app = page.frameLocator(".surface:not([hidden]) iframe");
		await app.getByRole("link", { name: "controlled frame" }).click();
		await app.frameLocator("#cf iframe").locator("body").waitFor();
		await page.waitForTimeout(4000);
		await shoot(page, "controlled-frame");
		await page.close();
	}

	// Socket Lab talking to the internet, with developer tools on the Sockets tab.
	{
		const page = await browser.newPage({ viewport });
		await page.goto(host.origin);
		await page.evaluate(() => {
			localStorage.setItem("iyowa:devtools", "open");
			localStorage.setItem("iyowa:devtools-tab", "sockets");
			localStorage.setItem("iyowa:devtools-height", "250");
		});
		await page.reload();
		await open(page, "Socket Lab");
		const app = page.frameLocator(".surface:not([hidden]) iframe");
		await app.locator("#preset").selectOption({ label: "HTTP GET example.com" });
		await app.locator("#tcp").getByText("connection closed").waitFor({ timeout: 20000 });
		await app.getByRole("button", { name: "Resolve via 1.1.1.1" }).click();
		await app.locator("#misc").getByText("udp:").waitFor({ timeout: 10000 });
		await shoot(page, "devtools");
		await page.close();
	}
	console.log(`Wrote screenshots to ${out}`);
} finally {
	await browser.close();
	await host.close();
	await rm(data, { recursive: true, force: true });
}
