import { KeyRound, Loader2, Terminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { getToken, setToken, validateToken } from "~/client/api";
import { useRouter } from "~/client/router";

export function LoginPage() {
	const { navigate } = useRouter();
	const inputRef = useRef<HTMLInputElement>(null);
	const [value, setValue] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [checking, setChecking] = useState(() => typeof window !== "undefined");

	useEffect(() => {
		const existing = getToken();

		if (!existing) {
			setChecking(false);
			return;
		}

		setLoading(true);
		validateToken(existing)
			.then(() => navigate("/", { replace: true }))
			.catch(() => {
				setChecking(false);
				setLoading(false);
			});
	}, [navigate]);

	useEffect(() => {
		if (!checking) {
			inputRef.current?.focus();
		}
	}, [checking]);

	async function handleSubmit(event: React.FormEvent) {
		event.preventDefault();
		const token = value.trim();

		if (!token) {
			return;
		}

		setLoading(true);
		setError(null);

		try {
			await validateToken(token);
			setToken(token);
			navigate("/", { replace: true });
		} catch {
			setError("Invalid token. Check your SHELLEPORT_ADMIN_TOKEN.");
			setLoading(false);
		}
	}

	if (checking || loading) {
		return (
			<main className="grid h-screen place-items-center bg-background">
				<Loader2 className="size-4 animate-spin text-muted-foreground" />
			</main>
		);
	}

	return (
		<main className="relative flex h-screen items-center justify-center bg-background px-4">
			<div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_500px_350px_at_50%_42%,oklch(0.12_0_0),transparent)]" />

			<div className="relative z-10 w-full max-w-[320px]">
				<div className="mb-12 text-center">
					<div className="mx-auto mb-5 flex size-12 items-center justify-center rounded-lg border border-border bg-card">
						<Terminal className="size-5 text-foreground/70" />
					</div>
					<h1 className="text-sm font-semibold uppercase tracking-[0.2em] text-foreground">
						shelleport
					</h1>
					<p className="mt-2 text-xs text-muted-foreground">Remote Claude Code control plane</p>
				</div>

				<form onSubmit={handleSubmit} className="space-y-3">
					<div className="relative">
						<KeyRound className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
						<input
							ref={inputRef}
							type="password"
							placeholder="Paste admin token"
							autoComplete="current-password"
							value={value}
							onChange={(event) => setValue(event.target.value)}
							className="h-10 w-full rounded-md border border-border bg-card pl-9 pr-3 text-xs text-foreground outline-none transition placeholder:text-muted-foreground focus:border-foreground/20 focus:ring-1 focus:ring-foreground/10"
						/>
					</div>

					{error && <p className="text-xs text-destructive">{error}</p>}

					<button
						type="submit"
						disabled={loading || !value.trim()}
						className="flex h-10 w-full items-center justify-center gap-2 rounded-md bg-foreground text-xs font-medium text-background transition hover:bg-foreground/90 disabled:opacity-30"
					>
						Connect
					</button>
				</form>

				<p className="mt-10 text-center text-[11px] text-muted-foreground/50">
					Token stored locally in your browser
				</p>
			</div>
		</main>
	);
}
