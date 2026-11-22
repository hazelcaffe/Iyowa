import { allowsIsolated, type IwaSession, type PermissionState, runtimeFeatures } from "@iyowa/sdk";
import { Ban, Cable, FileJson, ScrollText, ShieldCheck, X } from "lucide-react";
import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from "react";
import { formatBytes, runtime, useSession } from "../runtime.ts";

type Tab = "console" | "sockets" | "permissions" | "manifest";
const TABS: { id: Tab; label: string; icon: typeof ScrollText }[] = [
	{ id: "console", label: "Console", icon: ScrollText },
	{ id: "sockets", label: "Sockets", icon: Cable },
	{ id: "permissions", label: "Permissions", icon: ShieldCheck },
	{ id: "manifest", label: "Manifest", icon: FileJson },
];

export function DevTools({ session, onClose }: { session: IwaSession; onClose(): void }) {
	useSession(session);
	const [tab, setTab] = useState<Tab>(
		() => (localStorage.getItem("iyowa:devtools-tab") as Tab) || "console",
	);
	const [height, setHeight] = useState(() => Number(localStorage.getItem("iyowa:devtools-height")) || 260);
	useEffect(() => localStorage.setItem("iyowa:devtools-tab", tab), [tab]);
	useEffect(() => localStorage.setItem("iyowa:devtools-height", String(height)), [height]);

	const resize = (e: PointerEvent<HTMLDivElement>) => {
		const start = e.clientY,
			from = height;
		const target = e.currentTarget;
		target.setPointerCapture(e.pointerId);
		const move = (m: globalThis.PointerEvent) =>
			setHeight(Math.min(innerHeight - 160, Math.max(120, from + start - m.clientY)));
		const up = () => {
			target.removeEventListener("pointermove", move);
			target.removeEventListener("pointerup", up);
		};
		target.addEventListener("pointermove", move);
		target.addEventListener("pointerup", up);
	};
	const keyResize = (e: KeyboardEvent) => {
		if (e.key === "ArrowUp") setHeight((h) => Math.min(innerHeight - 160, h + 24));
		if (e.key === "ArrowDown") setHeight((h) => Math.max(120, h - 24));
	};
	const errors = session.console.filter((c) => c.level === "error").length;
	const open = [...session.sockets.values()].filter(
		(s) => s.state === "open" || s.state === "opening",
	).length;

	return (
		<section className="devtools" style={{ height }} aria-label="Developer tools">
			{/* biome-ignore lint/a11y/useSemanticElements: a draggable splitter has no native element */}
			<div
				className="resizer"
				role="separator"
				aria-orientation="horizontal"
				aria-label="Resize developer tools"
				aria-valuenow={height}
				tabIndex={0}
				onPointerDown={resize}
				onKeyDown={keyResize}
			/>
			<div className="devtools-tabs" role="tablist">
				{TABS.map(({ id, label, icon: Icon }) => (
					<button
						key={id}
						type="button"
						role="tab"
						aria-selected={tab === id}
						className={`tab${tab === id ? " current" : ""}`}
						onClick={() => setTab(id)}
					>
						<Icon size={14} />
						{label}
						{id === "console" && errors > 0 && (
							<span className="badge-count inline">{errors}</span>
						)}
						{id === "sockets" && open > 0 && (
							<span className="badge-count inline neutral">{open}</span>
						)}
					</button>
				))}
				<button
					type="button"
					className="icon-button small push"
					aria-label="Close developer tools"
					onClick={onClose}
				>
					<X size={14} />
				</button>
			</div>
			<div className="devtools-body" role="tabpanel">
				{tab === "console" && <ConsolePanel session={session} />}
				{tab === "sockets" && <SocketsPanel session={session} />}
				{tab === "permissions" && <PermissionsPanel session={session} />}
				{tab === "manifest" && (
					<pre className="code">{JSON.stringify(session.app.manifest, null, 2)}</pre>
				)}
			</div>
		</section>
	);
}

function ConsolePanel({ session }: { session: IwaSession }) {
	const [filter, setFilter] = useState("");
	const [levels, setLevels] = useState(new Set(["log", "info", "warn", "error", "debug"]));
	const list = useRef<HTMLOListElement>(null);
	const stick = useRef(true);
	const entries = session.console.filter(
		(e) => levels.has(e.level) && (!filter || e.message.toLowerCase().includes(filter.toLowerCase())),
	);
	useEffect(() => {
		if (stick.current && list.current) list.current.scrollTop = list.current.scrollHeight;
	});
	const toggle = (level: string) =>
		setLevels((s) => {
			const next = new Set(s);
			if (next.has(level)) next.delete(level);
			else next.add(level);
			return next;
		});
	return (
		<div className="console">
			<div className="console-bar">
				<input
					placeholder="Filter"
					value={filter}
					onChange={(e) => setFilter(e.target.value)}
					aria-label="Filter console"
				/>
				{["error", "warn", "info", "log", "debug"].map((level) => (
					<button
						key={level}
						type="button"
						className={`chip toggle${levels.has(level) ? " on" : ""} ${level}`}
						aria-pressed={levels.has(level)}
						onClick={() => toggle(level)}
					>
						{level}
					</button>
				))}
				<button
					type="button"
					className="icon-button small push"
					aria-label="Clear console"
					title="Clear"
					onClick={() => session.clearConsole()}
				>
					<Ban size={14} />
				</button>
			</div>
			<ol
				className="console-list"
				ref={list}
				onScroll={(e) => {
					const el = e.currentTarget;
					stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
				}}
			>
				{entries.length === 0 && <li className="console-empty">No messages</li>}
				{entries.map((entry) => (
					<li key={entry.id} className={`console-entry ${entry.level}`}>
						<time>{new Date(entry.time).toLocaleTimeString()}</time>
						<span>{entry.message}</span>
					</li>
				))}
			</ol>
		</div>
	);
}

function SocketsPanel({ session }: { session: IwaSession }) {
	const sockets = [...session.sockets.values()].reverse();
	if (!sockets.length)
		return (
			<p className="panel-empty">
				No Direct Sockets yet. TCP and UDP sockets the app opens appear here with their route:{" "}
				<b>in-app</b> loopback, the <b>network</b> relay, or a <b>system</b> port on this computer.
			</p>
		);
	return (
		<table className="table">
			<thead>
				<tr>
					<th>Type</th>
					<th>Route</th>
					<th>Local</th>
					<th>Remote</th>
					<th>State</th>
					<th className="num">Sent</th>
					<th className="num">Received</th>
				</tr>
			</thead>
			<tbody>
				{sockets.map((s) => (
					<tr key={s.id} title={s.error}>
						<td>{s.kind === "tcp-server" ? "TCP server" : s.kind.toUpperCase()}</td>
						<td>
							<span className={`route ${s.route}`}>{s.route}</span>
						</td>
						<td className="mono">{s.local || "—"}</td>
						<td className="mono">{s.remote || "—"}</td>
						<td>
							<span className={`state ${s.state}`}>{s.state}</span>
							{s.error && <span className="subtle"> {s.error}</span>}
						</td>
						<td className="num mono">{formatBytes(s.sent ?? 0)}</td>
						<td className="num mono">{formatBytes(s.received ?? 0)}</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}

export function PermissionsPanel({ session }: { session: IwaSession }) {
	return <PermissionsList app={session.app} />;
}

export function PermissionsList({ app }: { app: IwaSession["app"] }) {
	const [saving, setSaving] = useState(false);
	const features = Object.keys(app.manifest.permissions_policy ?? {});
	const local =
		allowsIsolated(app.manifest, "direct-sockets-private", app.id) ||
		allowsIsolated(app.manifest, "controlled-frame", app.id);
	const set = async (state: PermissionState) => {
		setSaving(true);
		try {
			await runtime.setPermission(app.id, "local-network", state);
		} finally {
			setSaving(false);
		}
	};
	return (
		<div className="permissions">
			{local && (
				<div className="permission-row">
					<div>
						<strong>Local network access</strong>
						<span className="subtle">
							Connect to this computer and LAN devices, and accept connections. Without it,
							sockets stay in-app and frames load public sites only.
						</span>
					</div>
					<select
						value={app.permissions["local-network"]}
						disabled={saving}
						onChange={(e) => set(e.target.value as PermissionState)}
						aria-label="Local network access"
					>
						<option value="prompt">Ask</option>
						<option value="granted">Allow</option>
						<option value="denied">Block</option>
					</select>
				</div>
			)}
			<h3 className="small-heading">Declared in the manifest</h3>
			{features.length === 0 ? (
				<p className="subtle">This app doesn't request any policy-controlled features.</p>
			) : (
				<ul className="feature-list">
					{features.map((f) => (
						<li key={f}>
							<code>{f}</code>
							<span className="subtle">
								{runtimeFeatures[f] ??
									"Browser feature (subject to the browser's own permission prompts)"}
							</span>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
