export type AppRoute =
	| {
			kind: "home";
			pathname: "/";
			params: {};
	  }
	| {
			kind: "archived";
			pathname: "/archived";
			params: {};
	  }
	| {
			kind: "session";
			pathname: string;
			params: {
				sessionId: string;
			};
	  }
	| {
			kind: "login";
			pathname: "/login";
			params: {};
	  }
	| {
			kind: "logout";
			pathname: "/logout";
			params: {};
	  }
	| {
			kind: "not-found";
			pathname: string;
			params: {};
	  };

export function matchAppRoute(pathname: string): AppRoute {
	if (pathname === "/") {
		return {
			kind: "home",
			pathname: "/",
			params: {},
		};
	}

	if (pathname === "/archived") {
		return {
			kind: "archived",
			pathname: "/archived",
			params: {},
		};
	}

	if (pathname === "/login") {
		return {
			kind: "login",
			pathname: "/login",
			params: {},
		};
	}

	if (pathname === "/logout") {
		return {
			kind: "logout",
			pathname: "/logout",
			params: {},
		};
	}

	const sessionMatch = pathname.match(/^\/sessions\/([^/]+)$/);

	if (sessionMatch) {
		return {
			kind: "session",
			pathname,
			params: {
				sessionId: decodeURIComponent(sessionMatch[1]),
			},
		};
	}

	return {
		kind: "not-found",
		pathname,
		params: {},
	};
}

export function isAppShellRoute(route: AppRoute) {
	return route.kind === "home" || route.kind === "archived" || route.kind === "session";
}
