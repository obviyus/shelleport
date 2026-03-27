import { timingSafeEqual } from "node:crypto";
import { ApiError } from "~/server/api-error.server";
import { config } from "~/server/config.server";

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

function isAuthenticated(request: Request) {
	const bearerToken = getBearerToken(request);

	return bearerToken !== null && isValidAdminToken(bearerToken);
}

export function requireApiAuth(request: Request) {
	if (!isAuthenticated(request)) {
		throw new ApiError(401, "unauthorized", "Unauthorized");
	}
}
