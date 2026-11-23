import { type AppInfo, type ExampleInfo, IwaRuntime, type IwaSession, type SocketEvent } from "@iyowa/sdk";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

export const runtime = new IwaRuntime();

export const errorText = (error: unknown) => String((error as Error)?.message ?? error) || "Unknown error";
export const isAbort = (error: unknown) => (error as Error)?.name === "AbortError";

/** Installed apps, refreshed whenever the runtime reports a library change. */
export function useApps() {
	const [apps, setApps] = useState<AppInfo[]>();
	const [error, setError] = useState<string>();
	const refresh = useCallback(async () => {
		try {
			const list = await runtime.list();
			list.sort((a, b) => a.name.localeCompare(b.name));
			setApps(list);
			setError(undefined);
		} catch (e) {
			setError(errorText(e));
		}
	}, []);
	useEffect(() => {
		void refresh();
		const onChange = () => void refresh();
		runtime.addEventListener("change", onChange);
		return () => runtime.removeEventListener("change", onChange);
	}, [refresh]);
	return { apps, error };
}

export function useExamples(): ExampleInfo[] {
	const [examples, setExamples] = useState<ExampleInfo[]>([]);
	useEffect(() => {
		runtime.examples().then(setExamples, () => setExamples([]));
	}, []);
	return examples;
}

const SESSION_EVENTS = ["ready", "title", "socket", "update", "stop"];
const versions = new WeakMap<IwaSession, number>();

/** Re-render when a session's observable state changes, at most once per frame. */
export function useSession(session: IwaSession | undefined): number {
	const subscribe = useCallback(
		(notify: () => void) => {
			if (!session) return () => {};
			let frame = 0;
			const handler = () => {
				frame ||= requestAnimationFrame(() => {
					frame = 0;
					versions.set(session, (versions.get(session) ?? 0) + 1);
					notify();
				});
			};
			for (const type of SESSION_EVENTS) session.addEventListener(type, handler);
			return () => {
				cancelAnimationFrame(frame);
				for (const type of SESSION_EVENTS) session.removeEventListener(type, handler);
			};
		},
		[session],
	);
	return useSyncExternalStore(subscribe, () => (session ? (versions.get(session) ?? 0) : 0));
}

export const formatBytes = (n: number) =>
	n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`;

export const appLabel = (app: AppInfo) => app.manifest.short_name || app.name;

export function describeSocket(s: SocketEvent): string {
	const kind = s.kind === "tcp-server" ? "TCP server" : s.kind.toUpperCase();
	const where = s.kind === "tcp-server" || !s.remote ? s.local : s.remote;
	// The route is decided while opening, so only report it once known.
	const route = s.state === "opening" ? "" : ` (${s.route})`;
	return `${kind}${where ? ` ${where}` : ""} ${s.state}${route}${s.error ? `: ${s.error}` : ""}`;
}
