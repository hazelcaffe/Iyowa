import type { AppInfo } from "@iyowa/sdk";
import { LayoutGrid, X } from "lucide-react";
import type { Running } from "../app.tsx";
import { AppIcon } from "./app-icon.tsx";

interface Props {
	apps: AppInfo[];
	running: Map<string, Running>;
	waiting: Set<string>;
	activeId?: string;
	onLibrary(): void;
	onSelect(app: AppInfo): void;
	onClose(id: string): void;
}

export function Sidebar({ apps, running, waiting, activeId, onLibrary, onSelect, onClose }: Props) {
	const open = apps.filter((a) => running.has(a.id));
	const pinned = apps.filter((a) => !running.has(a.id)).slice(0, 12);
	return (
		<nav className="sidebar" aria-label="Iyowa">
			<div className="brand">
				<img src="/favicon.svg" alt="" width={26} height={26} />
				<span>Iyowa</span>
			</div>
			<button type="button" className={`nav-item${activeId ? "" : " current"}`} onClick={onLibrary}>
				<LayoutGrid size={17} />
				<span>Library</span>
			</button>
			{open.length > 0 && (
				<>
					<h2 className="nav-heading">Running</h2>
					<ul className="nav-list">
						{open.map((app) => (
							<li key={app.id} className={`nav-app${app.id === activeId ? " current" : ""}`}>
								<button
									type="button"
									className="nav-app-main"
									onClick={() => onSelect(app)}
									title={app.name}
								>
									<AppIcon app={app} size={22} />
									<span className="nav-app-name">{app.name}</span>
									{waiting.has(app.id) && (
										<span className="dot attention" title="Waiting for your permission" />
									)}
								</button>
								<button
									type="button"
									className="icon-button small"
									aria-label={`Close ${app.name}`}
									onClick={() => onClose(app.id)}
								>
									<X size={14} />
								</button>
							</li>
						))}
					</ul>
				</>
			)}
			{pinned.length > 0 && (
				<>
					<h2 className="nav-heading">Apps</h2>
					<ul className="nav-list">
						{pinned.map((app) => (
							<li key={app.id} className="nav-app">
								<button
									type="button"
									className="nav-app-main"
									onClick={() => onSelect(app)}
									title={`Open ${app.name}`}
								>
									<AppIcon app={app} size={22} />
									<span className="nav-app-name">{app.name}</span>
								</button>
							</li>
						))}
					</ul>
				</>
			)}
			<footer className="sidebar-footer">
				<span>Isolated Web App runtime</span>
			</footer>
		</nav>
	);
}
