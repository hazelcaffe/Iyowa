import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { IntegrityBlockSigner, NodeCryptoSigningStrategy } from "wbn-sign-v1";
import { demoKey, probe } from "../fixtures/probe.ts";
import { bestIcon, readBundle, selectUpdate } from "../src/bundle/index.ts";
import { download } from "../src/host/download.ts";
import { createHost } from "../src/host/index.ts";
import { isPublicAddress } from "../src/host/relay.ts";
import { isPrivateHost } from "../src/shared/policy.ts";

test("legacy 1b, original reference signer: verified identity and tamper rejection", async () => {
	const current = Buffer.from(await probe()),
		length = Number(current.readBigUInt64BE(current.length - 8));
	for (const key of [demoKey, generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey]) {
		const { signedWebBundle } = await new IntegrityBlockSigner(
			current.subarray(-length),
			new NodeCryptoSigningStrategy(key),
		).sign();
		assert.equal(readBundle(signedWebBundle).id, readBundle(await probe({}, key)).id);
		const changed = Buffer.from(signedWebBundle);
		changed[changed.indexOf("Bundled JSON")] ^= 1;
		assert.throws(() => readBundle(changed), /signature/);
	}
});

test("Ed25519 and P-256 verified; reject forged identity and modified bytes", async () => {
	const a = await probe(),
		b = await probe({}, generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey);
	assert.notEqual(readBundle(a).id, readBundle(b).id);
	assert.throws(() => readBundle(a.subarray(200)));
	const bad = Buffer.from(a);
	bad[bad.indexOf("Bundled JSON")] ^= 1;
	assert.throws(() => readBundle(bad), /signature/);
	const forged = await probe({}, demoKey, readBundle(b).id);
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
	assert.throws(() => readBundle(Buffer.alloc(0)));
	const bad = await probe({ start_url: "https://example.com/" });
	assert.throws(() => readBundle(bad), /bundle-local/);
});

test("launcher icon prefers the largest bundled non-maskable icon", () => {
	const has = (p: string) => p !== "/missing.png";
	const icon = bestIcon(
		{
			version: "1",
			icons: [
				{ src: "/small.png", sizes: "48x48" },
				{ src: "/missing.png", sizes: "1024x1024" },
				{ src: "images/mask.png", sizes: "512x512", purpose: "maskable" },
				{ src: "/big.png", sizes: "256x256 192x192" },
			],
		},
		has,
	);
	assert.equal(icon?.path, "/big.png");
});

test("library and permissions survive a host restart; downgrades and conflicts are rejected", async () => {
	const dataDir = await mkdtemp(join(tmpdir(), "iyowa-store-"));
	let host = await createHost({ port: 0, dataDir });
	try {
		const bytes = await probe({ version: "2" });
		const app = await host.install(bytes);
		assert.equal(app.permissions["local-network"], "prompt");
		await host.setPermission(app.id, "local-network", "granted");
		await host.close();
		host = await createHost({ port: 0, dataDir });
		const [restored] = host.list();
		assert.equal(restored?.version, "2");
		assert.equal(restored?.permissions["local-network"], "granted");
		await assert.rejects(host.install(await probe()), /downgrade/);
		await assert.rejects(
			host.install(await probe({ version: "2", name: "different" })),
			/different bundle/,
		);
		await assert.rejects(
			host.setPermission(app.id, "local-network", "maybe" as "granted"),
			/Invalid permission/,
		);
	} finally {
		await host.close();
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

test("network policy separates public addresses from the local network", () => {
	for (const ip of ["93.184.215.14", "1.1.1.1", "2606:4700:4700::1111"])
		assert.equal(isPublicAddress(ip), true, ip);
	for (const ip of [
		"127.0.0.1",
		"::1",
		"10.0.0.8",
		"192.168.1.1",
		"169.254.1.1",
		"fd00::1",
		"::ffff:127.0.0.1",
		"224.0.0.251",
		"0.0.0.0",
	])
		assert.equal(isPublicAddress(ip), false, ip);
	for (const host of ["localhost", "printer.local", "192.168.0.10", "[::1]", "fe80::1"])
		assert.equal(isPrivateHost(host), true, host);
	for (const host of ["example.com", "8.8.8.8"]) assert.equal(isPrivateHost(host), false, host);
});
