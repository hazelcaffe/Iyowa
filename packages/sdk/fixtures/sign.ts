import { createHash, createPrivateKey, type KeyObject } from "node:crypto";
import { BundleBuilder } from "wbn";
import { NodeCryptoSigningStrategy, SignedWebBundle } from "wbn-sign";
import type { Manifest } from "../src/shared/types.ts";

/** Deterministic, PUBLIC Ed25519 keys for fixtures and examples. Never sign real software with these. */
export const testKey = (label: string): KeyObject =>
	createPrivateKey({
		key: Buffer.concat([
			Buffer.from("302e020100300506032b657004220420", "hex"),
			createHash("sha256").update(label).digest(),
		]),
		format: "der",
		type: "pkcs8",
	});

const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript",
	".css": "text/css",
	".json": "application/json",
	".svg": "image/svg+xml",
	".webmanifest": "application/manifest+json",
};

/** Build and sign an IWA from in-memory files ("/" and "*\/" paths are served as HTML). */
export async function signApp(
	manifest: Manifest,
	files: Record<string, string | Uint8Array>,
	key: KeyObject,
	overrideId?: string,
): Promise<Uint8Array> {
	const bundle = new BundleBuilder("b2");
	bundle.addExchange(
		"/.well-known/manifest.webmanifest",
		200,
		{ "content-type": TYPES[".webmanifest"] as string },
		JSON.stringify(manifest, null, 2),
	);
	for (const [path, body] of Object.entries(files)) {
		const ext = /\.[a-z]+$/.exec(path)?.[0] ?? "";
		const type = path.endsWith("/") ? TYPES[".html"] : (TYPES[ext] ?? "application/octet-stream");
		bundle.addExchange(path, 200, { "content-type": type as string }, body);
	}
	const signed = await SignedWebBundle.fromWebBundle(
		bundle.createBundle(),
		[new NodeCryptoSigningStrategy(key)],
		overrideId ? { webBundleId: overrideId } : undefined,
	);
	return signed.getSignedWebBundleBytes();
}
