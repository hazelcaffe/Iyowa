import { type AppInfo, type ExampleInfo, IwaRuntime, type IwaSession } from "@iyowa/sdk";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

export const runtime = new IwaRuntime();

/** Installed apps, refreshed whenever the runtime reports a library change. */
export function useApps() {
	const [apps, setApps] = useState<AppInfo[]>();
	const [error, setError] = useState<string>();
	const refresh = useCallback(async () => {
		try {
			const list = await runtime.list();
			list.sort((a, b) => b.installedAt - a.installedAt || a.name.localeCompare(b.name));
			setApps(list);
			setError(undefined);
		} catch (e) {
			setError(String((e as Error).message ?? e));
		}
	}, []);
	useEffect(() => {
		void refresh();
		const onChange = () => void refresh();
		runtime.addEventListener("change", onChange);
		return () => runtime.removeEventListener("change", onChange);
	}, [refresh]);
	return { apps, error, refresh };
}

export function useExamples() {
	const [examples, setExamples] = useState<ExampleInfo[]>([]);
	useEffect(() => {
		runtime.examples().then(setExamples, () => setExamples([]));
	}, []);
	return examples;
}

const SESSION_EVENTS = ["ready", "title", "console", "socket", "update", "stop", "error"];

/** Re-render when a session's observable state changes. Returns a change counter. */
export function useSession(session: IwaSession | undefined): number {
	const subscribe = useCallback(
		(notify: () => void) => {
			if (!session) return () => {};
			let queued = false;
			// Coalesce bursts (console floods) into one render per frame.
			const handler = () => {
				if (queued) return;
				queued = true;
				requestAnimationFrame(() => {
					queued = false;
					version.set(session, (version.get(session) ?? 0) + 1);
					notify();
				});
			};
			for (const type of SESSION_EVENTS) session.addEventListener(type, handler);
			return () => {
				for (const type of SESSION_EVENTS) session.removeEventListener(type, handler);
			};
		},
		[session],
	);
	return useSyncExternalStore(subscribe, () => (session ? (version.get(session) ?? 0) : 0));
}
const version = new WeakMap<IwaSession, number>();

export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function shortId(id: string): string {
	return `${id.slice(0, 8)}…${id.slice(-6)}`;
}
