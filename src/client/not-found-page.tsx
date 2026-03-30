export function NotFoundPage() {
	return (
		<main className="grid h-screen place-items-center bg-background px-4">
			<div className="text-center">
				<p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">404</p>
				<h1 className="mt-3 text-sm font-semibold text-foreground">Page not found</h1>
				<p className="mt-2 text-xs text-muted-foreground">The requested page does not exist.</p>
			</div>
		</main>
	);
}
