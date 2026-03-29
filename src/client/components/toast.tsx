import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, X } from "lucide-react";

type ToastKind = "error" | "success";

type Toast = {
	id: number;
	kind: ToastKind;
	message: string;
};

type ToastContextValue = {
	showToast: (kind: ToastKind, message: string) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

let nextToastId = 1;

export function useToast() {
	const context = useContext(ToastContext);

	if (context === null) {
		throw new Error("ToastProvider is required");
	}

	return context;
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
	return (
		<div
			className={`flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-xs shadow-lg backdrop-blur-sm animate-in slide-in-from-bottom-2 fade-in duration-200 ${
				toast.kind === "error"
					? "border-destructive/30 bg-destructive/10 text-destructive"
					: "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
			}`}
		>
			{toast.kind === "error" ? (
				<AlertCircle className="mt-px size-3.5 shrink-0" />
			) : (
				<CheckCircle2 className="mt-px size-3.5 shrink-0" />
			)}
			<span className="min-w-0 flex-1 leading-relaxed">{toast.message}</span>
			<button
				type="button"
				onClick={() => onDismiss(toast.id)}
				className="mt-px shrink-0 rounded p-0.5 transition hover:bg-foreground/10"
			>
				<X className="size-3" />
			</button>
		</div>
	);
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
	const [toasts, setToasts] = useState<Toast[]>([]);

	const dismiss = useCallback((id: number) => {
		setToasts((current) => current.filter((toast) => toast.id !== id));
	}, []);

	const showToast = useCallback(
		(kind: ToastKind, message: string) => {
			const id = nextToastId++;
			setToasts((current) => [...current, { id, kind, message }]);
			setTimeout(() => dismiss(id), 4000);
		},
		[dismiss],
	);

	const value = useMemo(() => ({ showToast }), [showToast]);

	return (
		<ToastContext.Provider value={value}>
			{children}
			<div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-4">
				{toasts.map((toast) => (
					<div key={toast.id} className="pointer-events-auto w-full max-w-sm">
						<ToastItem toast={toast} onDismiss={dismiss} />
					</div>
				))}
			</div>
		</ToastContext.Provider>
	);
}
