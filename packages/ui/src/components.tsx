import type { AppInfo, ExampleInfo, IwaSession, PermissionRequestEvent, SocketEvent } from "@iyowa/sdk";
import {
	Alert,
	Anchor,
	Badge,
	Button,
	CloseButton,
	Group,
	Loader,
	Menu,
	Stack,
	Table,
	Text,
	Title,
} from "@mantine/core";
import { type KeyboardEvent, type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { catalog } from "./catalog.ts";
import { logs, useLogs } from "./logs.ts";
import { appLabel, formatBytes, runtime, useSession } from "./runtime.ts";

/** Manifest icon, or a monogram tile derived from the app's identity. */
export function AppIcon({ app, size = 16 }: { app: AppInfo; size?: number }) {
	const [broken, setBroken] = useState(false);
	const src = !broken ? runtime.iconURL(app) : undefined;
	if (src)
		return (
			<img
				className="app-icon"
				src={src}
				alt=""
				width={size}
				height={size}
				onError={() => setBroken(true)}
			/>
		);
	let hash = 0;
	for (const c of app.id) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
	return (
		<span
			className="app-icon monogram"
			aria-hidden="true"
			style={{
				width: size,
				height: size,
				fontSize: size * 0.6,
				background: `hsl(${hash % 360} 55% 48%)`,
			}}
		>
			{[...app.name.trim()][0]?.toUpperCase() ?? "?"}
		</span>
	);
}

export function Home(props: {
	ready: boolean;
	failure?: string;
	hasApps: boolean;
	examples: ExampleInfo[];
	onBundle(): void;
	onURL(): void;
	onExample(example: ExampleInfo): void;
	onCatalog(url: string): void;
}) {
	return (
		<div className="overlay" id="home">
			<Stack gap="lg" maw={560}>
				<Stack gap={6}>
					<Title order={2}>Run an Isolated Web App</Title>
					<Text c="dimmed">
						Install a signed web bundle (<code>.swbn</code>) or its update manifest URL. The app
						runs in this tab with Direct Sockets, Controlled Frame and screen capture, and its
						data stays in this browser.
					</Text>
				</Stack>
				{props.failure ? (
					<Alert color="red" title="The Iyowa host isn’t reachable">
						<Text size="sm" className="pre">
							{props.failure}
						</Text>
					</Alert>
				) : (
					<Group gap="sm">
						<Button id="open-bundle" disabled={!props.ready} onClick={props.onBundle}>
							Open bundle
						</Button>
						<Button variant="default" disabled={!props.ready} onClick={props.onURL}>
							Install from URL
						</Button>
						<Menu position="bottom-start" shadow="md" width={300}>
							<Menu.Target>
								<Button variant="subtle" disabled={!props.ready || !props.examples.length}>
									Try an example
								</Button>
							</Menu.Target>
							<Menu.Dropdown>
								{props.examples.map((example) => (
									<Menu.Item key={example.file} onClick={() => props.onExample(example)}>
										<Text size="sm">{example.name}</Text>
										<Text size="xs" c="dimmed" lineClamp={2}>
											{example.description}
										</Text>
									</Menu.Item>
								))}
							</Menu.Dropdown>
						</Menu>
					</Group>
				)}
				<Text size="xs" c="dimmed" className="where">
					{props.hasApps
						? "Pick an installed app at the top and press Run, or drop another bundle here."
						: "You can also drop a .swbn file here."}
					<br />
					Public apps:{" "}
					{catalog.map((entry, i) => (
						<span key={entry.id}>
							{i > 0 && " · "}
							<Anchor
								component="button"
								type="button"
								size="xs"
								disabled={!props.ready}
								onClick={() => props.onCatalog(entry.url)}
							>
								{entry.name}
							</Anchor>
						</span>
					))}
				</Text>
			</Stack>
		</div>
	);
}

/** Shown over the stage while the running app has nothing on screen. */
export function StageNote(props: {
	id?: string;
	busy?: boolean;
	title: string;
	detail?: string;
	children?: ReactNode;
}) {
	return (
		<div className="overlay" id={props.id} aria-live="polite">
			<Stack align="center" gap="xs" maw={560} ta="center">
				{props.busy && <Loader size="sm" />}
				<Text fw={600}>{props.title}</Text>
				{props.detail && (
					<Text size="sm" c="dimmed" className="pre">
						{props.detail}
					</Text>
				)}
				{props.children && <Group mt="xs">{props.children}</Group>}
			</Stack>
		</div>
	);
}

export interface TabItem {
	id: string;
	app: AppInfo;
	session: IwaSession;
	state: "loading" | "active" | "background" | "failed";
}

/** Running apps, one tab each (shown once more than one app is running). */
export function AppTabs(props: { items: TabItem[]; onShow(id: string): void; onClose(id: string): void }) {
	const keys = (event: KeyboardEvent<HTMLDivElement>) => {
		const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role='tab']")];
		const index = tabs.indexOf(event.target as HTMLButtonElement);
		if (index < 0) return;
		if (event.key === "Delete") {
			const id = tabs[index]?.closest<HTMLElement>("[data-app-id]")?.dataset.appId;
			if (id) props.onClose(id);
			return;
		}
		const next = {
			ArrowRight: (index + 1) % tabs.length,
			ArrowLeft: (index - 1 + tabs.length) % tabs.length,
			Home: 0,
			End: tabs.length - 1,
		}[event.key];
		if (next === undefined) return;
		event.preventDefault();
		tabs[next]?.focus();
	};
	return (
		<nav className="tabs" aria-label="Running apps">
			<div id="app-tablist" role="tablist" aria-label="Running apps" onKeyDown={keys}>
				{props.items.map((item) => (
					<Tab key={item.id} item={item} onShow={props.onShow} onClose={props.onClose} />
				))}
			</div>
		</nav>
	);
}

function Tab({
	item,
	onShow,
	onClose,
}: {
	item: TabItem;
	onShow(id: string): void;
	onClose(id: string): void;
}) {
	useSession(item.session);
	const title = item.session.title || item.app.name;
	return (
		<div className="app-tab" role="presentation" data-app-id={item.id} data-state={item.state}>
			<button
				type="button"
				role="tab"
				className="app-tab-select"
				aria-selected={item.state === "active"}
				tabIndex={item.state === "active" ? 0 : -1}
				title={`${title}\n${item.session.url}`}
				onClick={() => onShow(item.id)}
				onAuxClick={(event) => event.button === 1 && onClose(item.id)}
			>
				<AppIcon app={item.app} />
				<span className="app-tab-title">{title}</span>
			</button>
			<CloseButton
				className="app-tab-close"
				size="sm"
				tabIndex={-1}
				aria-label={`Close ${item.app.name}`}
				title="Close app"
				onClick={() => onClose(item.id)}
			/>
		</div>
	);
}

/** Like Neutron's device request: the app is waiting for an answer only the user can give. */
export function PermissionBar(props: {
	app: AppInfo;
	request: PermissionRequestEvent;
	onAnswer(state: "granted" | "denied"): void;
}) {
	return (
		<Alert id="permission-request" className="permission-request" color="blue" variant="light">
			<Group justify="space-between" wrap="nowrap">
				<Text size="sm">
					<b>{props.app.name}</b> wants to access your local network
					{props.request.reason ? ` to ${props.request.reason}` : ""}. Blocking keeps its sockets
					inside the app.
				</Text>
				<Group gap="xs" wrap="nowrap">
					<Button size="xs" onClick={() => props.onAnswer("granted")}>
						Allow
					</Button>
					<Button size="xs" variant="subtle" color="gray" onClick={() => props.onAnswer("denied")}>
						Block
					</Button>
				</Group>
			</Group>
		</Alert>
	);
}

const time = (value: number) => new Date(value).toLocaleTimeString([], { hour12: false });

export function LogPanel(props: { onClose(): void }) {
	const { entries } = useLogs();
	const output = useRef<HTMLDivElement>(null);
	const follow = useRef(true);
	// biome-ignore lint/correctness/useExhaustiveDependencies: Scroll after each new batch of entries.
	useLayoutEffect(() => {
		if (output.current && follow.current) output.current.scrollTop = output.current.scrollHeight;
	}, [entries]);
	return (
		<section className="panel" aria-label="Logs">
			<Group className="panel-head" gap="xs">
				<Text size="sm" fw={600}>
					Logs
				</Text>
				<Text size="xs" c="dimmed">
					{entries.length.toLocaleString()} entries
				</Text>
				<div className="grow" />
				<Button size="compact-xs" variant="subtle" color="gray" onClick={() => logs.clear()}>
					Clear
				</Button>
				<CloseButton size="sm" aria-label="Close logs" onClick={props.onClose} />
			</Group>
			<div
				id="console-output"
				className="panel-body"
				role="log"
				aria-label="Runtime and app output"
				ref={output}
				onScroll={(event) => {
					const element = event.currentTarget;
					follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
				}}
			>
				{entries.length ? (
					entries.map((entry) => (
						<div key={entry.id} className={`log ${entry.level}`}>
							<time>{time(entry.time)}</time>
							<span className="source" title={entry.source}>
								{entry.source}
							</span>
							<pre>{entry.message}</pre>
						</div>
					))
				) : (
					<Text size="sm" c="dimmed" p="sm">
						Output from the runtime and your apps appears here.
					</Text>
				)}
			</div>
		</section>
	);
}
const ROUTE_COLORS: Record<SocketEvent["route"], string> = {
	"in-app": "gray",
	network: "blue",
	system: "orange",
};
const STATE_COLORS: Record<SocketEvent["state"], string> = {
	opening: "yellow",
	open: "green",
	closed: "gray",
	failed: "red",
};

export function SocketPanel(props: { session?: IwaSession; onClose(): void }) {
	useSession(props.session);
	const sockets = props.session ? [...props.session.sockets.values()].reverse() : [];
	const open = sockets.filter((s) => s.state === "open" || s.state === "opening").length;
	return (
		<section className="panel" aria-label="Sockets">
			<Group className="panel-head" gap="xs">
				<Text size="sm" fw={600}>
					Sockets
				</Text>
				<Text size="xs" c="dimmed">
					{props.session ? `${appLabel(props.session.app)} · ${open} open` : "No app running"}
				</Text>
				<div className="grow" />
				<CloseButton size="sm" aria-label="Close sockets" onClick={props.onClose} />
			</Group>
			<div className="panel-body">
				{sockets.length ? (
					<Table fz="xs" verticalSpacing={4} horizontalSpacing="sm" stickyHeader highlightOnHover>
						<Table.Thead>
							<Table.Tr>
								<Table.Th>Type</Table.Th>
								<Table.Th>Route</Table.Th>
								<Table.Th>Local</Table.Th>
								<Table.Th>Remote</Table.Th>
								<Table.Th>State</Table.Th>
								<Table.Th ta="right">Sent</Table.Th>
								<Table.Th ta="right">Received</Table.Th>
							</Table.Tr>
						</Table.Thead>
						<Table.Tbody>
							{sockets.map((s) => (
								<Table.Tr key={s.id} title={s.error}>
									<Table.Td>
										{s.kind === "tcp-server" ? "TCP server" : s.kind.toUpperCase()}
									</Table.Td>
									<Table.Td>
										<Badge
											size="xs"
											variant="light"
											radius="sm"
											tt="none"
											color={ROUTE_COLORS[s.route]}
										>
											{s.route}
										</Badge>
									</Table.Td>
									<Table.Td className="mono">{s.local || "—"}</Table.Td>
									<Table.Td className="mono">{s.remote || "—"}</Table.Td>
									<Table.Td>
										<Badge
											size="xs"
											variant="dot"
											radius="sm"
											tt="none"
											color={STATE_COLORS[s.state]}
										>
											{s.state}
										</Badge>
										{s.error && (
											<Text span size="xs" c="dimmed" ml={6}>
												{s.error}
											</Text>
										)}
									</Table.Td>
									<Table.Td ta="right" className="mono">
										{formatBytes(s.sent ?? 0)}
									</Table.Td>
									<Table.Td ta="right" className="mono">
										{formatBytes(s.received ?? 0)}
									</Table.Td>
								</Table.Tr>
							))}
						</Table.Tbody>
					</Table>
				) : (
					<Text size="sm" c="dimmed" p="sm">
						TCP and UDP sockets the app opens appear here, with their route: <b>in-app</b>{" "}
						loopback, the <b>network</b> relay, or a <b>system</b> port on this computer.
					</Text>
				)}
			</div>
		</section>
	);
}
