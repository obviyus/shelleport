import { AppShell } from "~/web/app-shell";
import { LoginPage } from "~/web/login-page";
import { NotFoundPage } from "~/web/not-found-page";
import { useCurrentRoute } from "~/web/router";

export function App({ defaultCwd }: { defaultCwd: string }) {
	const route = useCurrentRoute();

	if (route.kind === "login") {
		return <LoginPage />;
	}

	if (route.kind === "not-found") {
		return <NotFoundPage />;
	}

	return <AppShell defaultCwd={defaultCwd} />;
}
