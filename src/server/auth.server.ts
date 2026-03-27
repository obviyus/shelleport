import { timingSafeEqual } from "node:crypto";
import { ApiError } from "~/server/api-error.server";
import { config } from "~/server/config.server";

const AUTH_COOKIE_NAME = "shelleport_admin";

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

function getCookieToken(request: Request) {
	const header = request.headers.get("cookie");

	if (!header) {
		return null;
	}

	for (const part of header.split(";")) {
		const cookie = part.trim();

		if (!cookie.startsWith(`${AUTH_COOKIE_NAME}=`)) {
			continue;
		}

		return decodeURIComponent(cookie.slice(AUTH_COOKIE_NAME.length + 1));
	}

	return null;
}

export function isValidAdminToken(value: string) {
	return compareToken(value, config.adminToken);
}

export function isAuthenticated(request: Request) {
	const token = getCookieToken(request) ?? getBearerToken(request);

	return token !== null && isValidAdminToken(token);
}

function createCookie(value: string, maxAge: number) {
	const secure = Bun.env.NODE_ENV === "production" ? "; Secure" : "";
	return `${AUTH_COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export function createAuthCookie() {
	return createCookie(config.adminToken, 60 * 60 * 24 * 30);
}

export function clearAuthCookie() {
	return createCookie("", 0);
}

export function requireApiAuth(request: Request) {
	if (!isAuthenticated(request)) {
		throw new ApiError(401, "unauthorized", "Unauthorized");
	}
}
