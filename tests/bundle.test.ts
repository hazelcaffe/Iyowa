import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { IntegrityBlockSigner, NodeCryptoSigningStrategy } from "wbn-sign-v1";
import { demoKey, fixture } from "../fixtures/bundle.ts";
import { download } from "../host/download.ts";
import { createHost } from "../host/index.ts";
import { readBundle, selectUpdate } from "../runtime/bundle.ts";

test("legacy 1b, original reference signer: verified identity and tamper rejection", async () => {
	const current = Buffer.from(await fixture()),
		length = Number(current.readBigUInt64BE(current.length - 8));
	for (const key of [demoKey, generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey]) {
		const { signedWebBundle } = await new IntegrityBlockSigner(
			current.subarray(-length),
			new NodeCryptoSigningStrategy(key),
		).sign();
		assert.equal(readBundle(signedWebBundle).id, readBundle(await fixture({}, key)).id);
		const changed = Buffer.from(signedWebBundle);
		changed[changed.indexOf("Bundled JSON")] ^= 1;
		assert.throws(() => readBundle(changed), /signature/);
	}
});
test("Ed25519 and P-256 verified; reject forged identity and modified bytes", async () => {
	const a = await fixture(),
		b = await fixture({}, generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey);
	assert.notEqual(readBundle(a).id, readBundle(b).id);
	assert.throws(() => readBundle(a.subarray(200)));
	const bad = Buffer.from(a);
	bad[bad.indexOf("Bundled JSON")] ^= 1;
	assert.throws(() => readBundle(bad), /signature/);
	const forged = await fixture({}, demoKey, readBundle(b).id);
	assert.throws(() => readBundle(forged), /identity/);
});
test("stable channel compares numeric version components and checks signed start URL", async () => {
	assert.equal(
		selectUpdate({
			versions: [
				{ version: "1.9", src: "a" },
				{ version: "1.10", src: "b" },
				{ version: "2", src: "c", channels: ["beta"] },
			],
		}).src,
		"b",
	);
	const bad = await fixture({ start_url: "https://example.com/" });
	assert.throws(() => readBundle(bad), /bundle-local/);
});
test("installed app survives host restart; downgrade/conflicting versions rejected", async () => {
	const dataDir = await mkdtemp(join(tmpdir(), "iyowa-store-"));
	let h = await createHost({ port: 0, dataDir });
	try {
		const bytes = await fixture({ version: "2" });
		await h.install(bytes);
		await h.close();
		h = await createHost({ port: 0, dataDir });
		assert.equal(h.list()[0]?.version, "2");
		await assert.rejects(h.install(await fixture()), /downgrade/);
		await assert.rejects(h.install(await fixture({ version: "2", name: "different" })), /conflicting/);
		await assert.rejects(h.install(bytes, undefined, "wrong"), /identity/);
	} finally {
		await h.close();
		await rm(dataDir, { recursive: true, force: true });
	}
});
test("URL imports refuse local addresses and non-HTTPS schemes", async () => {
	for (const u of [
		"https://127.0.0.1/file",
		"http://example.com/",
		"https://[::1]/file",
		"file:///tmp/file",
	])
		await assert.rejects(download(u));
});
