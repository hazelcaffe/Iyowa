import { useEffect, useState } from "react";

export type LogLevel = "debug" | "log" | "info" | "warn" | "error";
export interface LogEntry {
	id: number;
	time: number;
	level: LogLevel;
	/** "runtime", "install", or the app that wrote it. */
	source: string;
	message: string;
}

const LIMIT = 5000;

/** Launcher-wide log: runtime events plus every running app's console and sockets. */
class Logs extends EventTarget {
	entries: readonly LogEntry[] = [];
	errors = 0;
	#seq = 0;

	add(source: string, level: LogLevel, message: string) {
		const entry = { id: ++this.#seq, time: Date.now(), level, source, message };
		const next = [...this.entries, entry];
		this.entries = next.length > LIMIT ? next.slice(-LIMIT) : next;
		if (level === "error") this.errors++;
		this.dispatchEvent(new Event("change"));
	}
	clear() {
		this.entries = [];
		this.errors = 0;
		this.dispatchEvent(new Event("change"));
	}
}

export const logs = new Logs();

/** The current entries, updated at most once per frame. */
export function useLogs(): { entries: readonly LogEntry[]; errors: number } {
	const [state, setState] = useState(() => ({ entries: logs.entries, errors: logs.errors }));
	useEffect(() => {
		let frame = 0;
		const update = () => {
			frame ||= requestAnimationFrame(() => {
				frame = 0;
				setState({ entries: logs.entries, errors: logs.errors });
			});
		};
		update();
		logs.addEventListener("change", update);
		return () => {
			cancelAnimationFrame(frame);
			logs.removeEventListener("change", update);
		};
	}, []);
	return state;
}
