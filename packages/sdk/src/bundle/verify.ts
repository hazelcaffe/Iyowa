import { createHash } from "node:crypto";
import { Bundle } from "wbn";
import { SignedWebBundle } from "wbn-sign";
import type { Manifest, ManifestIcon } from "../shared/types.ts";
import { verifyLegacy } from "./legacy.ts";

export const MAX_BYTES = 128 * 1024 * 1024;
export const MANIFEST = "/.well-known/manifest.webmanifest";
export const RESERVED = "/.iyowa/";
export const validVersion = (v: unknown): v is string =>
	typeof v === "string" && /^\d{1,9}(?:\.\d{1,9}){0,15}$/.test(v);
export function compareVersions(a: string, b: string) {
	const x = a.split(".").map(Number),
		y = b.split(".").map(Number);
	for (let i = 0; i < Math.max(x.length, y.length); i++)
		if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
	return 0;
}
export function selectUpdate(
	manifest: { versions?: { version: string; src: string; channels?: string[] }[] },
	channel = "default",
) {
	if (!Array.isArray(manifest?.versions))
		throw Error("Expected an IWA update manifest with a versions array");
	const candidates = manifest.versions.filter(
		(v) =>
			validVersion(v?.version) &&
			typeof v.src === "string" &&
			(v.channels === undefined
				? channel === "default"
				: Array.isArray(v.channels) && v.channels.includes(channel)),
	);
	const result = candidates.sort((a, b) => compareVersions(b.version, a.version))[0];
	if (!result) throw Error(`No version on channel ${channel}`);
	return result;
}

export type VerifiedBundle = ReturnType<typeof readBundle>;

/** Choose the icon a launcher should show: the largest non-maskable bundled image. */
export function bestIcon(
	manifest: Manifest,
	has: (path: string) => boolean,
): (ManifestIcon & { path: string }) | undefined {
	const size = (icon: ManifestIcon) =>
		icon.sizes === "any"
			? 4096
			: Math.max(0, ...(icon.sizes || "").split(/\s+/).map((s) => Number.parseInt(s, 10) || 0));
	const candidates = (manifest.icons || [])
		.map((icon) => {
			try {
				const u = new URL(icon.src, "isolated-app://bundle/.well-known/manifest.webmanifest");
				return { ...icon, path: u.pathname + u.search };
			} catch {
				return undefined;
			}
		})
		.filter((icon): icon is ManifestIcon & { path: string } => !!icon && has(icon.path));
	const plain = candidates.filter((icon) => (icon.purpose || "any").split(/\s+/).includes("any"));
	return (plain.length ? plain : candidates).sort((a, b) => size(b) - size(a))[0];
}

/** Verify before indexing or exposing any resource. The asserted ID must actually sign the payload. */
export function readBundle(bytes: Uint8Array) {
	if (!(bytes instanceof Uint8Array) || bytes.length < 32 || bytes.length > MAX_BYTES)
		throw Error("Invalid signed bundle size (limit 128 MiB)");
	const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const length = Number(data.readBigUInt64BE(data.length - 8));
	if (
		!Number.isSafeInteger(length) ||
		length < 16 ||
		length >= data.length ||
		data.length - length > 1024 * 1024
	)
		throw Error("Expected a signed Web Bundle (.swbn)");
	const id =
		data[0] === 0x83
			? verifyLegacy(data.subarray(0, -length), data.subarray(-length))
			: verifyCurrent(data, length);
	function verifyCurrent(data: Buffer, length: number): string {
		const signed = SignedWebBundle.fromBytes(
			new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
		);
		const id: unknown = signed.getWebBundleId();
		if (typeof id !== "string") throw Error("Invalid signing identity");
		if (!Buffer.from(signed.getIntegrityBlock().toCbor()).equals(data.subarray(0, -length)))
			throw Error("Unsupported or non-canonical integrity block");
		const signatures = signed.validateSignatures();
		if (
			!signatures.length ||
			signatures.some((s) => s.status !== "success" || !s.isValid) ||
			!signatures.some((s) => s.status === "success" && s.derivedBundleId === id)
		)
			throw Error("Invalid bundle signature or signing identity");
		return id;
	}
	const origin = `isolated-app://${id}`,
		bundle = new Bundle(data.subarray(-length)),
		resources = new Map<string, ReturnType<Bundle["getResponse"]>>();
	function local(value: string, base = `${origin}/`) {
		const u = new URL(value, base);
		if (
			u.protocol !== "isolated-app:" ||
			u.host !== id ||
			u.username ||
			u.password ||
			!u.pathname.startsWith("/") ||
			u.pathname.startsWith("//") ||
			u.pathname.startsWith(RESERVED)
		)
			throw Error(`Invalid bundle-local URL: ${value}`);
		return u;
	}
	for (const key of bundle.urls) {
		const u = local(key),
			path = u.pathname + u.search;
		if (u.hash || resources.has(path)) throw Error("Duplicate or fragmented bundle exchange");
		const res = bundle.getResponse(key);
		if (!Number.isInteger(res.status) || res.status < 200 || res.status > 599)
			throw Error("Invalid exchange status");
		resources.set(path, res);
	}
	const entry = resources.get(MANIFEST);
	if (entry?.status !== 200) throw Error(`Missing ${MANIFEST}`);
	const manifest: Manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(entry.body));
	if (!validVersion(manifest.version)) throw Error("Missing or invalid IWA version");
	const start = local(manifest.start_url || "/", origin + MANIFEST);
	if (!(resources.has(start.pathname + start.search) || resources.has(start.pathname)))
		throw Error("Manifest start_url is missing from the bundle");
	const name = manifest.name || manifest.short_name;
	if (typeof name !== "string" || !name.trim()) throw Error("Manifest has no app name");
	return {
		id,
		origin,
		manifest,
		resources,
		name,
		version: manifest.version,
		startPath: start.pathname + start.search + start.hash,
		size: data.length,
		digest: createHash("sha256").update(data).digest("hex"),
		exchanges: resources.size,
	};
}
