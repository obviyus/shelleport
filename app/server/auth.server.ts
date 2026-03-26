import { timingSafeEqual } from "node:crypto";
import { redirect } from "react-router";
import { config } from "~/server/config.server";
import { getSession } from "~/server/session.server";

function compareToken(input: string, expected: string) {
	const inputBuffer = Buffer.from(input);
	const expectedBuffer = Buffer.from(expected);

	if (inputBuffer.length !== expectedBuffer.length) {
		return false;
	}

	return timingSafeEqual(inputBuffer, expectedBuffer);
}

function getBearerToken(request: Request) {
	const header = request.headers.get("authorization");

	if (!header?.startsWith("Bearer ")) {
		return null;
	}

	return header.slice("Bearer ".length);
}

export function isValidAdminToken(value: string) {
	return compareToken(value, config.adminToken);
}

async function isAuthenticated(request: Request) {
	const bearerToken = getBearerToken(request);

	if (bearerToken) {
		return isValidAdminToken(bearerToken);
	}

	const session = await getSession(request.headers.get("Cookie"));
	return session.get("authenticated") === true;
}

export async function requireAuth(request: Request) {
	if (!(await isAuthenticated(request))) {
		throw redirect("/login");
	}
}

export async function requireApiAuth(request: Request) {
	if (!(await isAuthenticated(request))) {
		throw Response.json({ error: "Unauthorized" }, { status: 401 });
	}
}
