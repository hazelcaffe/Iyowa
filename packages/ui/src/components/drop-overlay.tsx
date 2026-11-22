import type { AppInfo } from "@iyowa/sdk";
import { Upload } from "lucide-react";
import { useEffect, useState } from "react";
import { runtime } from "../runtime.ts";

/** Drop a .swbn anywhere in the window to install and open it. */
export function DropOverlay({
	onInstalled,
	toast,
}: {
	onInstalled(app: AppInfo): void;
	toast(m: string, t?: "error"): void;
}) {
	const [active, setActive] = useState(false);
	useEffect(() => {
		let depth = 0;
		const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files");
		const enter = (e: DragEvent) => {
			if (!hasFiles(e)) return;
			depth++;
			setActive(true);
		};
		const leave = (e: DragEvent) => {
			if (!hasFiles(e)) return;
			depth = Math.max(0, depth - 1);
			if (!depth) setActive(false);
		};
		const over = (e: DragEvent) => {
			if (hasFiles(e)) e.preventDefault();
		};
		const drop = async (e: DragEvent) => {
			if (!hasFiles(e)) return;
			e.preventDefault();
			depth = 0;
			setActive(false);
			for (const file of e.dataTransfer?.files ?? []) {
				try {
					onInstalled(await runtime.install(file));
				} catch (error) {
					toast(`${file.name}: ${(error as Error).message}`, "error");
				}
			}
		};
		addEventListener("dragenter", enter);
		addEventListener("dragleave", leave);
		addEventListener("dragover", over);
		addEventListener("drop", drop);
		return () => {
			removeEventListener("dragenter", enter);
			removeEventListener("dragleave", leave);
			removeEventListener("dragover", over);
			removeEventListener("drop", drop);
		};
	}, [onInstalled, toast]);
	if (!active) return null;
	return (
		<div className="drop-overlay">
			<div className="drop-card">
				<Upload size={36} />
				<strong>Drop to install</strong>
				<span>Signed web bundles (.swbn) are verified before anything runs.</span>
			</div>
		</div>
	);
}
