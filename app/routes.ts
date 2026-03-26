import { index, type RouteConfig, route } from "@react-router/dev/routes";

export default [
	index("routes/home.tsx"),
	route("api/*", "routes/api.ts"),
	route("login", "routes/login.tsx"),
	route("logout", "routes/logout.ts"),
] satisfies RouteConfig;
