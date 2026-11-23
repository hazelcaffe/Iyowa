import type { AppInfo, ExampleInfo, IwaSession, PermissionRequestEvent, PermissionState } from "@iyowa/sdk";
import { Badge, Button, Menu, NativeSelect, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { catalog } from "./catalog.ts";
import {
	AppTabs,
	Home,
	LogPanel,
	PermissionBar,
	SocketPanel,
	StageNote,
	type TabItem,
} from "./components.tsx";
import { InstallProgress, SettingsDialog, URLDialog } from "./dialogs.tsx";
import { type LogLevel, logs, useLogs } from "./logs.ts";
import {
	appLabel,
	describeSocket,
	errorText,
	isAbort,
	runtime,
	useApps,
	useExamples,
	useSession,
} from "./runtime.ts";

interface Running {
	session: IwaSession;
	/** Long-lived element holding the app frame. Re-parenting an iframe reloads it, so it never moves. */
	surface: HTMLDivElement;
	phase: "starting" | "running" | "failed";
	error?: string;
}
interface Prompt {
	appId: string;
	request: PermissionRequestEvent;
}
type Panel = "logs" | "sockets";
type Status = "initializing" | "ready" | "starting" | "running" | "failed" | "unavailable";

const COLORS: Record<Status, string> = {
	initializing: "yellow",
	ready: "blue",
	starting: "yellow",
	running: "green",
	failed: "red",
	unavailable: "red",
};
const SELECTED = "iyowa:selected";

const notify = (message: string, title?: string) => notifications.show({ title, message });

export function App() {
	const { apps, error } = useApps();
	const examples = useExamples();
	const { errors } = useLogs();
	const running = useRef(new Map<string, Running>()).current;
	const [, rerender] = useReducer((n: number) => n + 1, 0);
	const [selected, setSelected] = useState(() => localStorage.getItem(SELECTED) ?? "");
	const [active, setActive] = useState<string>();
	const [prompts, setPrompts] = useState<Prompt[]>([]);
	const [panel, setPanel] = useState<Panel>();
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [urlOpen, setURLOpen] = useState(false);
	const [task, setTask] = useState<string>();
	const [dragging, setDragging] = useState(false);
	const desktop = useRef<HTMLDivElement>(null);
	const bundleInput = useRef<HTMLInputElement>(null);
	const busy = useRef(false);

	const report = useCallback((problem: unknown, title = "Something went wrong") => {
		const message = errorText(problem);
		notifications.show({ color: "red", title, message: message.split("\n")[0] });
		logs.add("runtime", "error", `${title}: ${message}`);
	}, []);

	const select = useCallback(
		(id: string) => {
			setSelected(id);
			localStorage.setItem(SELECTED, id);
			if (running.has(id)) setActive(id);
		},
		[running],
	);

	const stop = useCallback(
		(id: string) => {
			const entry = running.get(id);
			if (!entry) return;
			running.delete(id);
			entry.session.stop();
			entry.surface.remove();
			logs.add("runtime", "info", `Stopped ${entry.session.app.name}`);
			setPrompts((list) =>
				list.filter((p) => {
					if (p.appId !== id) return true;
					p.request.deny();
					return false;
				}),
			);
			setActive((current) => (current === id ? [...running.keys()].at(-1) : current));
			rerender();
		},
		[running],
	);

	/** Start the app in a fresh session; an already running copy restarts. */
	const launch = useCallback(
		(app: AppInfo, path?: string) => {
			const host = desktop.current;
			if (!host) return;
			stop(app.id);
			const surface = document.createElement("div");
			surface.className = "surface";
			host.append(surface);
			const session = runtime.launch(app, surface, path ? { path } : {});
			const entry: Running = { session, surface, phase: "starting" };
			const source = appLabel(app);
			session.addEventListener("permissionrequest", (event) => {
				const request = event as PermissionRequestEvent;
				request.preventDefault();
				setPrompts((list) => [...list, { appId: app.id, request }]);
			});
			session.addEventListener("console", (event) => {
				const detail = (event as CustomEvent).detail as
					| { level: LogLevel; message: string }
					| undefined;
				if (detail) logs.add(source, detail.level, detail.message);
			});
			session.addEventListener("socket", (event) => {
				const socket = (event as CustomEvent).detail;
				const level: LogLevel =
					socket.state === "failed" ? "warn" : socket.state === "open" ? "info" : "debug";
				logs.add(source, level, describeSocket(socket));
			});
			session.ready.then(
				() => {
					entry.phase = "running";
					logs.add("runtime", "info", `${app.name} is running at ${session.url}`);
					rerender();
				},
				(problem: unknown) => {
					if (isAbort(problem) || running.get(app.id) !== entry) return;
					entry.phase = "failed";
					entry.error = errorText(problem);
					report(problem, `${app.name} couldn’t start`);
					rerender();
				},
			);
			running.set(app.id, entry);
			logs.add("runtime", "info", `Starting ${app.name} ${app.version} (${app.id})`);
			setSelected(app.id);
			localStorage.setItem(SELECTED, app.id);
			setActive(app.id);
			rerender();
		},
		[running, stop, report],
	);

	const install = useCallback(
		async (message: string, task: () => Promise<AppInfo>) => {
			if (busy.current) return notify("An install is already in progress.");
			busy.current = true;
			setTask(message);
			try {
				const app = await task();
				logs.add(
					"install",
					"info",
					`${app.name} ${app.version} · ${app.exchanges} resources · ${app.id}`,
				);
				notify(`${app.name} ${app.version}`, "Installed");
				launch(app);
			} catch (problem) {
				report(problem, "Install failed");
			} finally {
				busy.current = false;
				setTask(undefined);
			}
		},
		[launch, report],
	);
	const installFile = useCallback(
		(file: File) => install(`Verifying ${file.name}…`, () => runtime.install(file)),
		[install],
	);
	const installURL = (url: string) => {
		setURLOpen(false);
		void install("Downloading and verifying…", () => runtime.installURL(url));
	};
	const installExample = (example: ExampleInfo) =>
		void install(`Installing ${example.name}…`, async () => {
			const response = await fetch(example.url);
			if (!response.ok) throw new Error(`Couldn’t load the example (HTTP ${response.status})`);
			return runtime.install(await response.blob());
		});

	// Apps removed elsewhere stop. A fresh install launches before the list refreshes, so only
	// apps that were listed before count as removed.
	const listed = useRef(new Set<string>());
	useEffect(() => {
		if (!apps) return;
		const ids = new Set(apps.map((a) => a.id));
		for (const id of listed.current) if (!ids.has(id)) stop(id);
		listed.current = ids;
		if (!ids.has(selected) && !running.has(selected) && apps[0]) select(apps[0].id);
	}, [apps, running, selected, select, stop]);

	// Only the active app's frame is visible.
	useEffect(() => {
		for (const [id, entry] of running) entry.surface.hidden = id !== active;
	});

	// Keyboard shortcut and drag-and-drop install anywhere on the page.
	const latest = useRef({ installFile });
	latest.current = { installFile };
	useEffect(() => {
		let depth = 0;
		const files = (event: DragEvent) => event.dataTransfer?.types.includes("Files");
		const events = {
			keydown: (event: KeyboardEvent) => {
				if ((event.ctrlKey || event.metaKey) && event.key === "`") {
					event.preventDefault();
					setPanel((open) => (open === "logs" ? undefined : "logs"));
				}
			},
			dragenter: (event: DragEvent) => {
				if (!files(event)) return;
				event.preventDefault();
				depth++;
				setDragging(true);
			},
			dragover: (event: DragEvent) => {
				if (files(event)) event.preventDefault();
			},
			dragleave: () => {
				if (--depth <= 0) {
					depth = 0;
					setDragging(false);
				}
			},
			drop: (event: DragEvent) => {
				if (!files(event)) return;
				event.preventDefault();
				depth = 0;
				setDragging(false);
				const file = event.dataTransfer?.files[0];
				if (file) void latest.current.installFile(file);
			},
		};
		for (const [name, listener] of Object.entries(events))
			document.addEventListener(name, listener as EventListener);
		return () => {
			for (const [name, listener] of Object.entries(events))
				document.removeEventListener(name, listener as EventListener);
		};
	}, []);

	const app = apps?.find((a) => a.id === selected);
	const current = active ? running.get(active) : undefined;
	useSession(current?.session);
	const name = current?.session.app.name ?? "The app";
	const status: Status = error
		? "unavailable"
		: !apps
			? "initializing"
			: !current
				? "ready"
				: current.phase === "starting"
					? "starting"
					: current.phase;
	const label: Record<Status, string> = {
		initializing: "Initializing",
		ready: "Runtime ready",
		starting: `Starting ${current ? appLabel(current.session.app) : "app"}`,
		running: "App running",
		failed: "App error",
		unavailable: "Host unavailable",
	};
	useEffect(() => {
		document.title = current ? `${current.session.title || current.session.app.name} · iyowa` : "iyowa";
	});

	const prompt = prompts.find((p) => p.appId === active) ?? prompts[0];
	const promptApp = prompt && running.get(prompt.appId)?.session.app;
	const answer = (p: Prompt, state: "granted" | "denied") => {
		p.request.respond(state);
		setPrompts((list) => list.filter((x) => x !== p));
		const target = running.get(p.appId)?.session.app;
		if (target)
			logs.add(
				"runtime",
				"info",
				`${state === "granted" ? "Allowed" : "Blocked"} local network access for ${target.name}`,
			);
	};
	const tabs: TabItem[] = [...running].map(([id, entry]) => ({
		id,
		app: entry.session.app,
		session: entry.session,
		state:
			entry.phase === "failed"
				? "failed"
				: id === active
					? "active"
					: entry.phase === "starting"
						? "loading"
						: "background",
	}));
	const openSockets = current
		? [...current.session.sockets.values()].filter((s) => s.state === "open" || s.state === "opening")
				.length
		: 0;
	const ready = Boolean(apps) && !error;
	const toggle = (which: Panel) => setPanel((open) => (open === which ? undefined : which));

	return (
		<div className="shell">
			<header className="bar">
				<Text fw={700} className="brand">
					iyowa
				</Text>
				<NativeSelect
					id="app-select"
					aria-label="App"
					size="xs"
					className="app-select"
					disabled={!apps?.length}
					value={app ? selected : ""}
					onChange={(event) => select(event.currentTarget.value)}
					data={
						apps?.length
							? apps.map((a) => ({ value: a.id, label: `${a.name} ${a.version}` }))
							: [{ value: "", label: "No apps installed" }]
					}
				/>
				<Button
					id="run-button"
					size="xs"
					disabled={!ready || !app || Boolean(task)}
					title={app && running.has(app.id) ? `Restart ${app.name}` : undefined}
					onClick={() => app && launch(app)}
				>
					Run
				</Button>
				<Button
					id="stop-button"
					size="xs"
					variant="default"
					disabled={!current}
					onClick={() => active && stop(active)}
				>
					Stop
				</Button>
				<Badge
					id="runtime-state"
					role="status"
					data-state={status}
					variant="dot"
					color={COLORS[status]}
					tt="none"
					size="lg"
					radius="sm"
				>
					{label[status]}
				</Badge>
				<div className="grow" />
				<Menu position="bottom-end" shadow="md" width={260}>
					<Menu.Target>
						<Button id="install-button" size="xs" variant="default" disabled={!ready}>
							Install
						</Button>
					</Menu.Target>
					<Menu.Dropdown>
						<Menu.Item onClick={() => bundleInput.current?.click()}>
							Signed bundle (.swbn)…
						</Menu.Item>
						<Menu.Item onClick={() => setURLOpen(true)}>From URL…</Menu.Item>
						{examples.length > 0 && <Menu.Divider />}
						{examples.length > 0 && <Menu.Label>Examples</Menu.Label>}
						{examples.map((example) => (
							<Menu.Item key={example.file} onClick={() => installExample(example)}>
								{example.name}
							</Menu.Item>
						))}
						<Menu.Divider />
						<Menu.Label>Public apps</Menu.Label>
						{catalog.map((entry) => (
							<Menu.Item key={entry.id} onClick={() => installURL(entry.url)}>
								{entry.name}
							</Menu.Item>
						))}
					</Menu.Dropdown>
				</Menu>
				<Button
					id="logs-button"
					size="xs"
					variant={panel === "logs" ? "light" : "subtle"}
					color={panel === "logs" ? undefined : "gray"}
					aria-pressed={panel === "logs"}
					title="Logs (Ctrl+`)"
					onClick={() => toggle("logs")}
					rightSection={
						errors > 0 && (
							<Badge id="error-count" size="xs" color="red" circle>
								{errors > 99 ? "99+" : errors}
							</Badge>
						)
					}
				>
					Logs
				</Button>
				<Button
					id="sockets-button"
					size="xs"
					variant={panel === "sockets" ? "light" : "subtle"}
					color={panel === "sockets" ? undefined : "gray"}
					aria-pressed={panel === "sockets"}
					onClick={() => toggle("sockets")}
					rightSection={
						openSockets > 0 && (
							<Badge size="xs" color="gray" circle>
								{openSockets}
							</Badge>
						)
					}
				>
					Sockets
				</Button>
				<Button
					id="settings-button"
					size="xs"
					variant="subtle"
					color="gray"
					disabled={!ready}
					onClick={() => setSettingsOpen(true)}
				>
					Settings
				</Button>
			</header>
			{tabs.length > 1 && <AppTabs items={tabs} onShow={select} onClose={stop} />}
			{prompt && promptApp && (
				<PermissionBar
					app={promptApp}
					request={prompt.request}
					onAnswer={(state) => answer(prompt, state)}
				/>
			)}
			<div className="stage">
				<div id="desktop" ref={desktop} />
				{!current && (
					<Home
						ready={ready}
						failure={error}
						hasApps={Boolean(apps?.length)}
						examples={examples}
						onBundle={() => bundleInput.current?.click()}
						onURL={() => setURLOpen(true)}
						onExample={installExample}
						onCatalog={installURL}
					/>
				)}
				{current?.phase === "starting" && <StageNote busy title={`Starting ${name}…`} />}
				{current?.phase === "failed" && (
					<StageNote id="launch-notice" title={`${name} couldn’t start`} detail={current.error}>
						<Button size="xs" variant="default" onClick={() => setPanel("logs")}>
							Show logs
						</Button>
						<Button size="xs" variant="default" onClick={() => active && stop(active)}>
							Close app
						</Button>
					</StageNote>
				)}
			</div>
			{panel === "logs" && <LogPanel onClose={() => setPanel(undefined)} />}
			{panel === "sockets" && (
				<SocketPanel session={current?.session} onClose={() => setPanel(undefined)} />
			)}
			<input
				ref={bundleInput}
				id="bundle-input"
				type="file"
				accept=".swbn,application/webbundle"
				aria-label="Signed web bundle"
				hidden
				onChange={(event) => {
					const input = event.currentTarget;
					const file = input.files?.[0];
					input.value = "";
					if (file) void installFile(file);
				}}
			/>
			<InstallProgress message={task} />
			<URLDialog opened={urlOpen} onClose={() => setURLOpen(false)} onInstall={installURL} />
			<SettingsDialog
				opened={settingsOpen}
				app={app}
				onClose={() => setSettingsOpen(false)}
				onPermission={(target, state: PermissionState) =>
					void runtime
						.setPermission(target.id, "local-network", state)
						.catch((e: unknown) => report(e))
				}
				onUpdate={async (target) => {
					try {
						const next = await runtime.update(target);
						notify(
							next.version === target.version
								? `${target.name} ${target.version} is the newest version.`
								: `${target.name} was updated to ${next.version}. Run it to use the new version.`,
							"Updates",
						);
					} catch (problem) {
						report(problem, "Couldn’t check for updates");
					}
				}}
				onRemove={async (target) => {
					try {
						stop(target.id);
						await runtime.remove(target.id);
						setSettingsOpen(false);
						notify(`${target.name} was removed.`);
						logs.add("runtime", "info", `Removed ${target.name} (${target.id})`);
					} catch (problem) {
						report(problem, "Couldn’t remove the app");
					}
				}}
				onOpen={(target, path) => {
					setSettingsOpen(false);
					launch(target, path);
				}}
			/>
			{dragging && (
				<div id="drop-overlay">
					<Text fw={600} size="lg">
						Drop to install
					</Text>
					<Text size="sm" c="dimmed">
						A signed web bundle (.swbn)
					</Text>
				</div>
			)}
		</div>
	);
}
