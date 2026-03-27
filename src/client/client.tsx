import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { App } from "~/client/app";
import type { AppBootData } from "~/client/boot";
import { fetchBootstrap } from "~/client/api";
import { BrowserRouterProvider } from "~/client/router";

const root = document.getElementById("root");

if (!root) {
	throw new Error("Missing root element");
}

function BootLoader() {
	const [boot, setBoot] = useState<AppBootData | null>(null);

	useEffect(() => {
		let cancelled = false;
		const pathname = window.location.pathname;

		fetchBootstrap(pathname)
			.then(({ boot: nextBoot }) => {
				if (cancelled) {
					return;
				}

				if (nextBoot.route.pathname !== pathname) {
					window.history.replaceState(null, "", nextBoot.route.pathname);
				}

				setBoot(nextBoot);
			})
			.catch((error) => {
				console.error("Bootstrap failed:", error);
			});

		return () => {
			cancelled = true;
		};
	}, []);

	if (!boot) {
		return (
			<div className="flex min-h-screen items-center justify-center bg-background text-[11px] uppercase tracking-[0.14em] text-muted-foreground/60">
				Loading
			</div>
		);
	}

	return (
		<BrowserRouterProvider initialRoute={boot.route}>
			<App boot={boot} />
		</BrowserRouterProvider>
	);
}

createRoot(root).render(<BootLoader />);
