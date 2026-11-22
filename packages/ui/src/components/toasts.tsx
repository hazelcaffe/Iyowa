import { CircleAlert, CircleCheck, Info, X } from "lucide-react";

export interface Toast {
	id: string;
	message: string;
	tone: "info" | "success" | "error";
}

export function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss(id: string): void }) {
	return (
		<div className="toasts" aria-live="polite">
			{toasts.map((t) => (
				<div key={t.id} className={`toast ${t.tone}`} role={t.tone === "error" ? "alert" : "status"}>
					{t.tone === "error" ? (
						<CircleAlert size={16} />
					) : t.tone === "success" ? (
						<CircleCheck size={16} />
					) : (
						<Info size={16} />
					)}
					<span>{t.message}</span>
					<button
						type="button"
						className="icon-button small"
						aria-label="Dismiss"
						onClick={() => onDismiss(t.id)}
					>
						<X size={14} />
					</button>
				</div>
			))}
		</div>
	);
}
