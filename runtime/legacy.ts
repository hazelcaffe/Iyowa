import { createHash, createPublicKey, ECDH, verify } from "node:crypto";
import { decode, encode } from "cborg";
import { WebBundleId } from "wbn-sign";

/** Historical 1b integrity blocks, as produced by wbn-sign 0.1.3, have no asserted ID. */
export function verifyLegacy(block: Buffer, payload: Buffer): string {
	const value: unknown = decode(block, { strict: true, useMaps: true });
	if (!Array.isArray(value) || value.length !== 3 || !Buffer.from(encode(value)).equals(block))
		throw Error("Malformed legacy integrity block");
	const [magic, version, stack] = value;
	if (
		!(magic instanceof Uint8Array) ||
		Buffer.from(magic).toString() !== "🖋📦" ||
		!(version instanceof Uint8Array) ||
		Buffer.from(version).toString() !== "1b\0\0" ||
		!Array.isArray(stack) ||
		stack.length !== 1
	)
		throw Error("Unsupported legacy signature stack");
	const entry = stack[0];
	if (
		!Array.isArray(entry) ||
		entry.length !== 2 ||
		!(entry[0] instanceof Map) ||
		entry[0].size !== 1 ||
		!(entry[1] instanceof Uint8Array)
	)
		throw Error("Invalid legacy signature");
	const [[algorithm, raw]] = entry[0];
	const ed = algorithm === "ed25519PublicKey";
	if (
		!(raw instanceof Uint8Array) ||
		(ed ? raw.length !== 32 : algorithm !== "ecdsaP256SHA256PublicKey" || raw.length !== 33)
	)
		throw Error("Unsupported legacy signing key");
	const prefix = ed ? "302a300506032b6570032100" : "3059301306072a8648ce3d020106082a8648ce3d030107034200";
	const point = ed
		? raw
		: (ECDH.convertKey(raw, "prime256v1", undefined, undefined, "uncompressed") as Buffer);
	const key = createPublicKey({
		format: "der",
		type: "spki",
		key: Buffer.concat([Buffer.from(prefix, "hex"), point]),
	});
	const parts = [
		createHash("sha512").update(payload).digest(),
		encode([magic, version, []]),
		encode(entry[0]),
	];
	const message = Buffer.concat(
		parts.flatMap((p) => {
			const size = Buffer.alloc(8);
			size.writeBigUInt64BE(BigInt(p.length));
			return [size, p];
		}),
	);
	if (!verify(ed ? null : "sha256", message, key, entry[1])) throw Error("Invalid legacy bundle signature");
	return new WebBundleId(key).serialize();
}
