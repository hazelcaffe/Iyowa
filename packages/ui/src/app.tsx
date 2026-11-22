import type { AppInfo, IwaSession, PermissionRequestEvent } from "@iyowa/sdk";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { AppDetails } from "./components/app-details.tsx";
import { AppToolbar } from "./components/app-toolbar.tsx";
import { DevTools } from "./components/devtools.tsx";
import { DropOverlay } from "./components/drop-overlay.tsx";
import { Library } from "./components/library.tsx";
import { PermissionPrompt } from "./components/permission-prompt.tsx";
import { Sidebar } from "./components/sidebar.tsx";
import { type Toast, Toasts } from "./components/toasts.tsx";
import { runtime, useApps } from "./runtime.ts";

export interface Running {
	session: IwaSession;
	/** Long-lived element holding the app frame. Re-parenting an iframe reloads it, so it never moves. */
	surface: HTMLDivElement;
}
interface Prompt {
	appId: string;
	request: PermissionRequestEvent;
}

type Route = { view: "library" } | { view: "app"; id: string };
const parseRoute = (): Route => {
	const m = /^#\/app\/([a-z2-7]+)/.exec(location.hash);
	return m?.[1] ? { view: "app", id: m[1] } : { view: "library" };
};

export function App() {
	const { apps, error } = useApps();
	const [route, setRoute] = useState<Route>(parseRoute);
	const runningRef = useRef(new Map<string, Running>());
	const [, rerender] = useReducer((n: number) => n + 1, 0);
	const [prompts, setPrompts] = useState<Prompt[]>([]);
	const [detailsId, setDetailsId] = useState<string>();
	const [toasts, setToasts] = useState<Toast[]>([]);
	const [devtools, setDevtools] = useState(() => localStorage.getItem("iyowa:devtools") === "open");
	const stage = useRef<HTMLDivElement>(null);
	const restored = useRef(false);
	const running = runningRef.current;

	const toast = useCallback((message: string, tone: Toast["tone"] = "info") => {
		const id = crypto.randomUUID();
		setToasts((list) => [...list.slice(-3), { id, message, tone }]);
		setTimeout(
			() => setToasts((list) => list.filter((t) => t.id !== id)),
			tone === "error" ? 8000 : 4000,
		);
	}, []);

	const navigate = useCallback((next: Route) => {
		const hash = next.view === "app" ? `#/app/${next.id}` : "#/";
		if (location.hash !== hash) history.pushState(null, "", hash);
		setRoute(next);
	}, []);
	useEffect(() => {
		const onPop = () => setRoute(parseRoute());
		addEventListener("popstate", onPop);
		return () => removeEventListener("popstate", onPop);
	}, []);

	const close = useCallback((id: string) => {
		const entry = runningRef.current.get(id);
		if (!entry) return;
		runningRef.current.delete(id);
		entry.session.stop();
		entry.surface.remove();
		setPrompts((list) =>
			list.filter((p) => {
				if (p.appId !== id) return true;
				p.request.deny();
				return false;
			}),
		);
		rerender();
	}, []);

	const open = useCallback(
		(app: AppInfo, path?: string) => {
			const existing = runningRef.current.get(app.id);
			if (existing && !existing.session.stopped) {
				if (path) existing.session.navigate(path);
			} else if (stage.current) {
				const surface = document.createElement("div");
				surface.className = "surface";
				stage.current.append(surface);
				const session = runtime.launch(app, surface, path ? { path } : {});
				session.addEventListener("permissionrequest", (event) => {
					const request = event as PermissionRequestEvent;
					request.preventDefault();
					setPrompts((list) => [...list, { appId: app.id, request }]);
				});
				session.ready.catch((e: Error) => {
					if (e.name !== "AbortError") toast(`${app.name}: ${e.message}`, "error");
				});
				runningRef.current.set(app.id, { session, surface });
				rerender();
			}
			navigate({ view: "app", id: app.id });
		},
		[navigate, toast],
	);

	// Reopen the app named in the URL after a reload.
	useEffect(() => {
		if (restored.current || !apps) return;
		restored.current = true;
		if (route.view !== "app") return;
		const app = apps.find((a) => a.id === route.id);
		if (app) open(app);
		else navigate({ view: "library" });
	}, [apps, route, open, navigate]);

	// Removed apps stop running.
	useEffect(() => {
		if (!apps) return;
		for (const id of [...runningRef.current.keys()]) if (!apps.some((a) => a.id === id)) close(id);
	}, [apps, close]);

	const activeId = route.view === "app" ? route.id : undefined;
	const active = activeId ? running.get(activeId) : undefined;
	useEffect(() => {
		for (const [id, entry] of runningRef.current) entry.surface.hidden = id !== activeId;
	});
	useEffect(() => {
		localStorage.setItem("iyowa:devtools", devtools ? "open" : "closed");
	}, [devtools]);

	const prompt = prompts.find((p) => p.appId === activeId);
	const answer = (p: Prompt, state: "granted" | "denied") => {
		p.request.respond(state);
		setPrompts((list) => list.filter((x) => x !== p));
	};
	const details = detailsId ? apps?.find((a) => a.id === detailsId) : undefined;
	const routedApp = activeId ? apps?.find((a) => a.id === activeId) : undefined;

	return (
		<div className="layout">
			<Sidebar
				apps={apps ?? []}
				running={running}
				waiting={new Set(prompts.map((p) => p.appId))}
				activeId={activeId}
				onLibrary={() => navigate({ view: "library" })}
				onSelect={(app) => open(app)}
				onClose={close}
			/>
			<main className="main">
				{route.view === "library" && (
					<Library
						apps={apps}
						error={error}
						running={running}
						onOpen={(app) => open(app)}
						onDetails={(app) => setDetailsId(app.id)}
						toast={toast}
					/>
				)}
				<section className="app-shell" hidden={route.view !== "app"} aria-label="App">
					{active && (
						<AppToolbar
							session={active.session}
							devtools={devtools}
							onDevtools={() => setDevtools((v) => !v)}
							onDetails={() => setDetailsId(active.session.app.id)}
							onClose={() => {
								close(active.session.app.id);
								navigate({ view: "library" });
							}}
						/>
					)}
					<div className="stage-wrap">
						<div className="stage" ref={stage} />
						{route.view === "app" && !active && (
							<div className="stage-empty">
								{routedApp ? (
									<button
										type="button"
										className="button primary"
										onClick={() => open(routedApp)}
									>
										Start {routedApp.name}
									</button>
								) : (
									<p>This app is not installed.</p>
								)}
							</div>
						)}
						{prompt && active && (
							<PermissionPrompt
								app={active.session.app}
								request={prompt.request}
								icon={runtime.iconURL(active.session.app)}
								onAnswer={(state) => answer(prompt, state)}
							/>
						)}
					</div>
					{active && devtools && (
						<DevTools session={active.session} onClose={() => setDevtools(false)} />
					)}
				</section>
			</main>
			{details && (
				<AppDetails
					app={details}
					running={running.has(details.id)}
					onClose={() => setDetailsId(undefined)}
					onOpen={(app, path) => {
						setDetailsId(undefined);
						open(app, path);
					}}
					onRemoved={(app) => {
						setDetailsId(undefined);
						close(app.id);
						if (activeId === app.id) navigate({ view: "library" });
						toast(`Removed ${app.name}`);
					}}
					toast={toast}
				/>
			)}
			<DropOverlay
				onInstalled={(app) => {
					toast(`Installed ${app.name} ${app.version}`, "success");
					open(app);
				}}
				toast={toast}
			/>
			<Toasts
				toasts={toasts}
				onDismiss={(id) => setToasts((list) => list.filter((t) => t.id !== id))}
			/>
		</div>
	);
}
