import { AppShell } from "~/client/app-shell";
import { LoginPage } from "~/client/login-page";
import { NotFoundPage } from "~/client/not-found-page";
import { useCurrentRoute } from "~/client/router";

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
