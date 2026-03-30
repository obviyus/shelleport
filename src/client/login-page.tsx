import { KeyRound, Loader2, Terminal } from "lucide-react";
import { useEffect, useState } from "react";
import { login, validateSession } from "~/client/api";

export function LoginPage() {
	const [value, setValue] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [checking, setChecking] = useState(() => typeof window !== "undefined");

	useEffect(() => {
		setLoading(true);
		validateSession()
			.then(() => {
				window.location.replace("/");
			})
			.catch(() => {
				setChecking(false);
				setLoading(false);
			});
	}, []);

	async function handleSubmit(event: React.FormEvent) {
		event.preventDefault();
		const token = value.trim();

		if (!token) {
			return;
		}

		setLoading(true);
		setError(null);

		try {
			await login(token);
			window.location.replace("/");
		} catch {
			setError("Invalid token. Run `shelleport token` on the host to print a fresh one.");
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

			<div className="relative z-10 w-full max-w-[360px]">
				<div className="mb-12 text-center">
					<div className="mx-auto mb-5 flex size-12 items-center justify-center rounded-lg border border-border bg-card">
						<Terminal className="size-5 text-foreground/70" />
					</div>
					<h1 className="text-sm font-semibold uppercase tracking-[0.2em] text-foreground">
						shelleport
					</h1>
					<p className="mt-2 text-xs text-muted-foreground">
						Connect with the admin token from the machine running shelleport
					</p>
				</div>

				<form onSubmit={handleSubmit} className="space-y-3">
					<div className="relative">
						<KeyRound className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
						<input
							type="password"
							placeholder="Paste admin token"
							autoComplete="current-password"
							autoFocus
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

				<div className="mt-4 rounded-md border border-border bg-card/80 px-4 py-3 text-[11px] leading-[1.7] text-muted-foreground">
					<p>The first launch prints the token once in the terminal.</p>
					<p className="mt-1">
						Need another one? Run{" "}
						<code className="rounded border border-border bg-background px-1 py-0.5 text-foreground/86">
							shelleport token
						</code>
					</p>
					<p className="mt-1">
						Need a setup check? Run{" "}
						<code className="rounded border border-border bg-background px-1 py-0.5 text-foreground/86">
							shelleport doctor
						</code>
					</p>
				</div>

				<p className="mt-10 text-center text-[11px] text-muted-foreground">
					Session secured with an HTTP-only cookie
				</p>
			</div>
		</main>
	);
}
