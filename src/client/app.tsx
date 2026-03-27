import { AppShell } from "~/client/app-shell";
import type { AppBootData } from "~/client/boot";
import { LoginPage } from "~/client/login-page";
import { NotFoundPage } from "~/client/not-found-page";
import { useCurrentRoute } from "~/client/router";

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

	return <AppShell boot={boot} />;
}
