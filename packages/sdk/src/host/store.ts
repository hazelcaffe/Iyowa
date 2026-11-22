import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { compareVersions, readBundle, type VerifiedBundle } from "../bundle/verify.ts";
import { defaultPermissions } from "../shared/policy.ts";
import type { PermissionName, PermissionState, Permissions } from "../shared/types.ts";

interface AppRecord {
	installedAt: number;
	permissions: Permissions;
}
interface State {
	version: 1;
	apps: Record<string, AppRecord>;
}

export type InstalledApp = VerifiedBundle & AppRecord;

const PERMISSION_STATES: PermissionState[] = ["prompt", "granted", "denied"];
const PERMISSION_NAMES: PermissionName[] = ["local-network"];

/** Verified packages plus per-app runtime state, persisted under one data directory. */
export class AppStore {
	readonly apps = new Map<string, InstalledApp>();
	private state: State = { version: 1, apps: {} };
	private queue: Promise<unknown> = Promise.resolve();
	private readonly dir: string;

	constructor(dir: string) {
		this.dir = dir;
	}

	async load(): Promise<void> {
		await mkdir(this.dir, { recursive: true, mode: 0o700 });
		try {
			const saved = JSON.parse(await readFile(join(this.dir, "state.json"), "utf8")) as State;
			if (saved?.version === 1 && saved.apps && typeof saved.apps === "object") this.state = saved;
		} catch {
			/* First run, or an unreadable state file: start with defaults. */
		}
		for (const file of await readdir(this.dir)) {
			if (!/^[a-z2-7]+\.swbn$/.test(file)) continue;
			const bundle = readBundle(await readFile(join(this.dir, file)));
			if (`${bundle.id}.swbn` !== file) throw Error(`Stored bundle ID mismatch: ${file}`);
			this.apps.set(bundle.id, { ...bundle, ...this.record(bundle.id) });
		}
	}

	private record(id: string): AppRecord {
		const saved = this.state.apps[id];
		this.state.apps[id] = {
			installedAt: saved?.installedAt ?? Date.now(),
			permissions: { ...defaultPermissions(), ...saved?.permissions },
		};
		return this.state.apps[id];
	}

	private serial<T>(task: () => Promise<T>): Promise<T> {
		const next = this.queue.then(task);
		this.queue = next.catch(() => {});
		return next;
	}

	private async atomic(file: string, data: string | Uint8Array): Promise<void> {
		const tmp = join(this.dir, `${randomUUID()}.tmp`);
		try {
			await writeFile(tmp, data, { mode: 0o600 });
			await rename(tmp, join(this.dir, file));
		} finally {
			await rm(tmp, { force: true });
		}
	}

	private saveState(): Promise<void> {
		return this.atomic("state.json", JSON.stringify(this.state, null, "\t"));
	}

	install(bytes: Uint8Array, expected: { version?: string; id?: string } = {}): Promise<InstalledApp> {
		return this.serial(async () => {
			const bundle = readBundle(bytes);
			if (expected.version && expected.version !== bundle.version)
				throw Error("Update manifest version does not match the signed application");
			if (expected.id && expected.id !== bundle.id)
				throw Error("The update is signed by a different key than the installed app");
			const previous = this.apps.get(bundle.id);
			if (previous) {
				const order = compareVersions(bundle.version, previous.version);
				if (order < 0) throw Error(`Refusing to downgrade ${previous.version} to ${bundle.version}`);
				if (order === 0 && previous.digest !== bundle.digest)
					throw Error(`A different bundle is already installed as version ${bundle.version}`);
			}
			await this.atomic(`${bundle.id}.swbn`, bytes);
			const app = { ...bundle, ...this.record(bundle.id) };
			await this.saveState();
			this.apps.set(bundle.id, app);
			return app;
		});
	}

	remove(id: string): Promise<void> {
		return this.serial(async () => {
			await rm(join(this.dir, `${id}.swbn`), { force: true });
			this.apps.delete(id);
			delete this.state.apps[id];
			await this.saveState();
		});
	}

	setPermission(id: string, name: PermissionName, state: PermissionState): Promise<InstalledApp> {
		return this.serial(async () => {
			const app = this.apps.get(id);
			if (!app) throw Error("Unknown app");
			if (!PERMISSION_NAMES.includes(name) || !PERMISSION_STATES.includes(state))
				throw Error("Invalid permission");
			app.permissions = { ...app.permissions, [name]: state };
			this.record(id).permissions = app.permissions;
			await this.saveState();
			return app;
		});
	}
}
