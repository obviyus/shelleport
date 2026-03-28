import { createContext, use, useEffect, useMemo, useState } from "react";
import { type AppRoute, matchAppRoute } from "~/client/routes";

type NavigateOptions = {
	replace?: boolean;
};

type AppRouter = {
	navigate: (to: string, options?: NavigateOptions) => void;
	route: AppRoute;
};

const RouterContext = createContext<AppRouter | null>(null);

function createBrowserRoute() {
	return matchAppRoute(window.location.pathname);
}

export function BrowserRouterProvider({
	children,
	initialRoute,
}: {
	children: React.ReactNode;
	initialRoute: AppRoute;
}) {
	const [route, setRoute] = useState(initialRoute);

	useEffect(() => {
		function syncRoute() {
			setRoute(createBrowserRoute());
		}

		syncRoute();
		window.addEventListener("popstate", syncRoute);

		return () => window.removeEventListener("popstate", syncRoute);
	}, []);

	const value = useMemo<AppRouter>(
		() => ({
			navigate(to, options) {
				const url = new URL(to, window.location.origin);
				const method = options?.replace ? "replaceState" : "pushState";

				window.history[method](null, "", url.pathname);
				setRoute(matchAppRoute(url.pathname));
			},
			route,
		}),
		[route],
	);

	return <RouterContext value={value}>{children}</RouterContext>;
}

export function StaticRouterProvider({
	children,
	route,
}: {
	children: React.ReactNode;
	route: AppRoute;
}) {
	const value = useMemo<AppRouter>(
		() => ({
			navigate() {
				throw new Error("Cannot navigate during server render");
			},
			route,
		}),
		[route],
	);

	return <RouterContext value={value}>{children}</RouterContext>;
}

export function useRouter() {
	const router = use(RouterContext);

	if (!router) {
		throw new Error("Router context missing");
	}

	return router;
}

export function useCurrentRoute() {
	return useRouter().route;
}
