import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Frame, Page } from "@playwright/test";
import { createHost, type IyowaHost } from "../../src/host/index.ts";

export const HARNESS = fileURLToPath(new URL("../harness/", import.meta.url));

export async function startHost(): Promise<IyowaHost & { cleanup(): Promise<void> }> {
	const dir = await mkdtemp(join(tmpdir(), "iyowa-e2e-"));
	const host = await createHost({ port: 0, dataDir: dir, ui: { dir: HARNESS } });
	return Object.assign(host, {
		async cleanup() {
			await host.close();
			await rm(dir, { recursive: true, force: true });
		},
	});
}

/** Open the SDK harness and launch an installed app; returns the app's frame. */
export async function launch(
	page: Page,
	host: IyowaHost,
	id: string,
	options: { path?: string; answer?: "granted" | "denied" } = {},
): Promise<Frame> {
	await page.goto(host.origin);
	await page.waitForFunction(() => document.title === "ready");
	const origin = await page.evaluate(
		async ([appId, path, answer]) => {
			const iyowa = (
				window as unknown as {
					iyowa: { answer: string; launch(id: string, path?: string): Promise<string> };
				}
			).iyowa;
			iyowa.answer = answer;
			return iyowa.launch(appId, path || undefined);
		},
		[id, options.path ?? "", options.answer ?? "denied"] as const,
	);
	const frame = page.frames().find((f) => f.url().startsWith(origin));
	if (!frame) throw new Error("App frame not found");
	return frame;
}

export const prompts = (page: Page) =>
	page.evaluate(
		() => (window as unknown as { iyowa: { prompts: { name: string; reason: string }[] } }).iyowa.prompts,
	);
