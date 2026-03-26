import { redirect } from "react-router";
import { destroySession, getSession } from "~/server/session.server";
import type { Route } from "./+types/logout";

async function handleLogout(request: Request) {
	const session = await getSession(request.headers.get("Cookie"));

	return redirect("/login", {
		headers: {
			"Set-Cookie": await destroySession(session),
		},
	});
}

export async function loader(args: Route.LoaderArgs) {
	return handleLogout(args.request);
}

export async function action(args: Route.ActionArgs) {
	return handleLogout(args.request);
}
