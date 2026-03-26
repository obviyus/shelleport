import type { Route } from "./+types/api";
import { handleApiRequest } from "~/server/api.server";

export async function loader({ request }: Route.LoaderArgs) {
	return handleApiRequest(request);
}

export async function action({ request }: Route.ActionArgs) {
	return handleApiRequest(request);
}
