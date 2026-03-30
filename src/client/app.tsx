import { Agentation } from "agentation";
import { AppShell } from "~/client/app-shell";
import type { AppBootData } from "~/client/boot";
import { ToastProvider } from "~/client/components/toast";
import { LoginPage } from "~/client/login-page";
import { NotFoundPage } from "~/client/not-found-page";
import { useCurrentRoute } from "~/client/router";

const isLocalBrowser =
	typeof window !== "undefined" &&
	(window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost");

export function App({ boot }: { boot: AppBootData }) {
	const route = useCurrentRoute();

	if (route.kind === "login") {
		return <LoginPage />;
	}

	if (route.kind === "not-found") {
		return <NotFoundPage />;
	}

	if (!boot.authenticated) {
		return <LoginPage />;
	}

	return (
		<ToastProvider>
			<AppShell boot={boot} />
			{isLocalBrowser && <Agentation endpoint="http://localhost:4747" />}
		</ToastProvider>
	);
}
