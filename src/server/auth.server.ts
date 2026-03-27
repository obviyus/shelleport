import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ApiError } from "~/server/api-error.server";
import { sessionStore } from "~/server/store.server";

const ADMIN_COOKIE_NAME = "shelleport_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 30;

type AuthSetup = {
	configuredByEnv: boolean;
	generatedToken: string | null;
};

type AuthStatus = {
	configuredByEnv: boolean;
	hasStoredTokenHash: boolean;
};

function getEnvAdminToken() {
	const token = Bun.env.SHELLEPORT_ADMIN_TOKEN?.trim();
	return token ? token : null;
}

function createToken() {
	return randomBytes(24).toString("base64url");
}

function createSecret() {
	return randomBytes(32).toString("base64url");
}

function getAuthState() {
	const current = sessionStore.getAuthState();
	const envAdminToken = getEnvAdminToken();

	if (envAdminToken) {
		if (!current) {
			const sessionSecret = createSecret();
			sessionStore.saveAuthState({
				adminTokenHash: null,
				sessionSecret,
			});

			return {
				adminTokenHash: null,
				configuredByEnv: true,
				generatedToken: null,
				sessionSecret,
			};
		}

		return {
			adminTokenHash: null,
			configuredByEnv: true,
			generatedToken: null,
			sessionSecret: current.session_secret,
		};
	}

	if (current?.admin_token_hash) {
		return {
			adminTokenHash: current.admin_token_hash,
			configuredByEnv: false,
			generatedToken: null,
			sessionSecret: current.session_secret,
		};
	}

	const generatedToken = createToken();
	const sessionSecret = current?.session_secret ?? createSecret();

	sessionStore.saveAuthState({
		adminTokenHash: Bun.password.hashSync(generatedToken),
		sessionSecret,
	});

	return {
		adminTokenHash: sessionStore.getAuthState()?.admin_token_hash ?? null,
		configuredByEnv: false,
		generatedToken,
		sessionSecret,
	};
}

function getBearerToken(request: Request) {
	const header = request.headers.get("authorization");

	if (!header?.startsWith("Bearer ")) {
		return null;
	}

	return header.slice("Bearer ".length);
}

function getCookieValue(request: Request, cookieName: string) {
	const header = request.headers.get("cookie");

	if (!header) {
		return null;
	}

	for (const part of header.split(";")) {
		const cookie = part.trim();

		if (!cookie.startsWith(`${cookieName}=`)) {
			continue;
		}

		return decodeURIComponent(cookie.slice(cookieName.length + 1));
	}

	return null;
}

function signSessionPayload(payload: string, secret: string) {
	return createHmac("sha256", secret).update(payload).digest("base64url");
}

function createCookie(value: string, maxAge: number) {
	const secure = Bun.env.NODE_ENV === "production" ? "; Secure" : "";
	return `${ADMIN_COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function hasValidSession(request: Request) {
	const token = getCookieValue(request, ADMIN_COOKIE_NAME);

	if (!token) {
		return false;
	}

	const separator = token.indexOf(".");

	if (separator === -1) {
		return false;
	}

	const payload = token.slice(0, separator);
	const signature = token.slice(separator + 1);
	const { sessionSecret } = getAuthState();
	const expectedSignature = signSessionPayload(payload, sessionSecret);
	const signatureBuffer = Buffer.from(signature);
	const expectedBuffer = Buffer.from(expectedSignature);

	if (signatureBuffer.length !== expectedBuffer.length) {
		return false;
	}

	if (!timingSafeEqual(signatureBuffer, expectedBuffer)) {
		return false;
	}

	const [expiresAt] = payload.split(":");
	return Number(expiresAt) > Date.now();
}

export function ensureAuthSetup() {
	const state = getAuthState();
	return {
		configuredByEnv: state.configuredByEnv,
		generatedToken: state.generatedToken,
	} satisfies AuthSetup;
}

export function getAuthStatus() {
	return {
		configuredByEnv: getEnvAdminToken() !== null,
		hasStoredTokenHash: sessionStore.getAuthState()?.admin_token_hash !== null,
	} satisfies AuthStatus;
}

export function rotateAdminToken() {
	if (getEnvAdminToken()) {
		throw new Error("Admin token is managed by SHELLEPORT_ADMIN_TOKEN");
	}

	const token = createToken();
	sessionStore.saveAuthState({
		adminTokenHash: Bun.password.hashSync(token),
		sessionSecret: createSecret(),
	});
	return token;
}

export function isValidAdminToken(value: string) {
	const adminToken = getEnvAdminToken();

	if (adminToken) {
		const valueBuffer = Buffer.from(value);
		const tokenBuffer = Buffer.from(adminToken);

		if (valueBuffer.length !== tokenBuffer.length) {
			return false;
		}

		return timingSafeEqual(valueBuffer, tokenBuffer);
	}

	const { adminTokenHash } = getAuthState();
	return adminTokenHash ? Bun.password.verifySync(value, adminTokenHash) : false;
}

export function isAuthenticated(request: Request) {
	return (
		hasValidSession(request) ||
		(() => {
			const token = getBearerToken(request);
			return token !== null && isValidAdminToken(token);
		})()
	);
}

export function createAuthCookie() {
	const expiresAt = Date.now() + SESSION_MAX_AGE * 1000;
	const nonce = createToken();
	const payload = `${expiresAt}:${nonce}`;
	const { sessionSecret } = getAuthState();
	const signature = signSessionPayload(payload, sessionSecret);
	return createCookie(`${payload}.${signature}`, SESSION_MAX_AGE);
}

export function clearAuthCookie() {
	return createCookie("", 0);
}

export function requireApiAuth(request: Request) {
	if (!isAuthenticated(request)) {
		throw new ApiError(401, "unauthorized", "Unauthorized");
	}
}
