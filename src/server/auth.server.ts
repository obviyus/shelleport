import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { ApiError } from "~/server/api-error.server";
import { sessionStore } from "~/server/store.server";

const ADMIN_COOKIE_NAME = "shelleport_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 30;
const CLIENT_IP_HEADER_NAME = "x-shelleport-client-ip";

const LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_RATE_LIMIT_MAX_ATTEMPTS = 10;

type LoginAttemptBucket = {
	count: number;
	resetTime: number;
};

const loginAttempts = new Map<string, LoginAttemptBucket>();

function isProxyTrusted() {
	const value = Bun.env.SHELLEPORT_TRUST_PROXY?.trim().toLowerCase();
	return value === "1" || value === "true" || value === "yes" || value === "on";
}

function readValidIp(value: string | null) {
	if (!value) {
		return null;
	}

	const normalized = value.trim();
	return normalized.length > 0 && isIP(normalized) ? normalized : null;
}

function getTrustedProxyIp(request: Request) {
	const forwardedFor = request.headers.get("x-forwarded-for");

	if (forwardedFor) {
		for (const part of forwardedFor.split(",")) {
			const ip = readValidIp(part);
			if (ip) {
				return ip;
			}
		}
	}

	return readValidIp(request.headers.get("x-real-ip"));
}

function getClientIp(request: Request): string {
	const resolvedClientIp = readValidIp(request.headers.get(CLIENT_IP_HEADER_NAME));
	const trustedProxyIp = isProxyTrusted() ? getTrustedProxyIp(request) : null;

	return trustedProxyIp || resolvedClientIp || "unknown";
}

function cleanupExpiredBuckets() {
	const now = Date.now();
	for (const [key, bucket] of loginAttempts) {
		if (now >= bucket.resetTime) {
			loginAttempts.delete(key);
		}
	}
}

export function checkLoginRateLimit(request: Request) {
	const ip = getClientIp(request);
	const now = Date.now();

	cleanupExpiredBuckets();

	const bucket = loginAttempts.get(ip);

	if (!bucket || now >= bucket.resetTime) {
		return;
	}

	if (bucket.count >= LOGIN_RATE_LIMIT_MAX_ATTEMPTS) {
		const retryAfterSeconds = Math.ceil((bucket.resetTime - now) / 1000);
		throw new ApiError(
			429,
			"rate_limited",
			`Too many login attempts. Try again in ${retryAfterSeconds} seconds.`,
		);
	}
}

export function recordFailedLoginAttempt(request: Request) {
	const ip = getClientIp(request);
	const now = Date.now();
	const bucket = loginAttempts.get(ip);

	if (!bucket || now >= bucket.resetTime) {
		loginAttempts.set(ip, {
			count: 1,
			resetTime: now + LOGIN_RATE_LIMIT_WINDOW_MS,
		});
		return;
	}

	bucket.count += 1;
}

export function resetLoginRateLimit(request: Request) {
	loginAttempts.delete(getClientIp(request));
}

type AuthSetup = {
	generatedToken: string | null;
};

type AuthStatus = {
	hasStoredTokenHash: boolean;
};

function createToken() {
	return randomBytes(24).toString("base64url");
}

function createSecret() {
	return randomBytes(32).toString("base64url");
}

function getAuthState() {
	const current = sessionStore.getAuthState();

	if (current?.admin_token_hash) {
		return {
			adminTokenHash: current.admin_token_hash,
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
		generatedToken: state.generatedToken,
	} satisfies AuthSetup;
}

export function getAuthStatus() {
	return {
		hasStoredTokenHash: sessionStore.getAuthState()?.admin_token_hash !== null,
	} satisfies AuthStatus;
}

export function setAdminToken(token = createToken()) {
	sessionStore.saveAuthState({
		adminTokenHash: Bun.password.hashSync(token),
		sessionSecret: createSecret(),
	});
	return token;
}

export function rotateAdminToken() {
	return setAdminToken();
}

export function isValidAdminToken(value: string) {
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
