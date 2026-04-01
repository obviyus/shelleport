import type { AppBootData } from "~/client/boot";
import { isAppShellRoute, matchAppRoute } from "~/client/routes";
import { isAuthenticated } from "~/server/auth.server";
import { refreshClaudeProviderLimits } from "~/server/providers/claude-usage.server";
import { listProviders } from "~/server/providers/registry.server";
import { sessionBroker } from "~/server/session-broker.server";
import { sessionStore } from "~/server/store.server";

type BootOptions = {
	defaultCwd: string;
	pathname: string;
	refreshProviderLimits?: boolean;
};

export async function buildAppBootData(
	request: Request,
	options: BootOptions,
): Promise<AppBootData> {
	let route = matchAppRoute(options.pathname);
	const authenticated = isAuthenticated(request);
	let sessionDetail =
		route.kind === "session" ? sessionBroker.getSessionDetail(route.params.sessionId) : null;

	if (route.kind === "login" && authenticated) {
		route = {
			kind: "home",
			params: {},
			pathname: "/",
		};
	}

	if (isAppShellRoute(route) && !authenticated) {
		route = {
			kind: "login",
			params: {},
			pathname: "/login",
		};
	}

	if (authenticated && route.kind === "session" && !sessionDetail) {
		route = {
			kind: "not-found",
			pathname: route.pathname,
			params: {},
		};
	}

	if (authenticated && options.refreshProviderLimits !== false) {
		await refreshClaudeProviderLimits();
	}

	return authenticated
		? ({
				authenticated: true,
				defaultCwd: options.defaultCwd,
				providers: await listProviders(),
				providerLimits: sessionStore.getProviderLimits(),
				projects: sessionStore.listProjects(),
				route,
				sessionDetail: route.kind === "session" ? sessionDetail : null,
				sessions: sessionBroker.listSessions(),
			} satisfies AppBootData)
		: ({
				authenticated: false,
				defaultCwd: options.defaultCwd,
				route,
			} satisfies AppBootData);
}
