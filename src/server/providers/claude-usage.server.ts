import { join } from "node:path";
import { config, getClaudeBin } from "~/server/config.server";
import { sessionStore } from "~/server/store.server";
import type { SessionLimit } from "~/shared/shelleport";

type ClaudeOAuthCredentials = {
	claudeAiOauth?: {
		accessToken?: unknown;
		refreshToken?: unknown;
		expiresAt?: unknown;
		scopes?: unknown;
		rateLimitTier?: unknown;
	};
};

type ClaudeUsageWindow = {
	utilization?: unknown;
	resets_at?: unknown;
};

type ClaudeUsageResponse = {
	five_hour?: ClaudeUsageWindow;
	seven_day?: ClaudeUsageWindow;
};

type ClaudeTokenRefreshResponse = {
	access_token?: unknown;
	refresh_token?: unknown;
	expires_in?: unknown;
};

type ClaudeCredentialRecord = {
	accessToken: string;
	refreshToken: string | null;
	expiresAt: number | null;
	rateLimitTier: string | null;
	scopes: string[];
};

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_USAGE_BETA = "oauth-2025-04-20";
const CLAUDE_USAGE_REFRESH_INTERVAL = 30_000;
const FALLBACK_CLAUDE_VERSION = "2.1.0";
const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";

let lastClaudeUsageRefreshTime = 0;
let claudeUsageRefreshPromise: Promise<void> | null = null;
let claudeVersionPromise: Promise<string> | null = null;

function readString(value: unknown) {
	return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readNumber(value: unknown) {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readScopes(value: unknown) {
	return Array.isArray(value)
		? value.filter((scope): scope is string => typeof scope === "string")
		: [];
}

function readIsoTime(value: unknown) {
	const isoTime = readString(value);

	if (!isoTime) {
		return null;
	}

	const parsed = Date.parse(isoTime);
	return Number.isFinite(parsed) ? parsed : null;
}

function getClaudeCredentialCachePath() {
	return join(config.dataDir, "claude-oauth.json");
}

function mapUsageWindow(window: string, usage: ClaudeUsageWindow | undefined): SessionLimit | null {
	if (!usage) {
		return null;
	}

	const utilization = readNumber(usage.utilization);
	const resetsAt = readIsoTime(usage.resets_at);

	if (utilization === null && resetsAt === null) {
		return null;
	}

	return {
		status: null,
		resetsAt,
		window,
		isUsingOverage: null,
		utilization,
	};
}

async function readClaudeCredentialsFile() {
	const credentialsPath = join(Bun.env.HOME ?? process.cwd(), ".claude", ".credentials.json");
	const file = Bun.file(credentialsPath);

	if (!(await file.exists())) {
		return null;
	}

	const parsed = (await file.json()) as ClaudeOAuthCredentials;
	return parsed.claudeAiOauth ?? null;
}

function readCredentialRecord(credentials: NonNullable<ClaudeOAuthCredentials["claudeAiOauth"]>) {
	const accessToken = readString(credentials.accessToken);

	if (!accessToken) {
		return null;
	}

	return {
		accessToken,
		refreshToken: readString(credentials.refreshToken),
		expiresAt: readNumber(credentials.expiresAt),
		rateLimitTier: readString(credentials.rateLimitTier),
		scopes: readScopes(credentials.scopes),
	} satisfies ClaudeCredentialRecord;
}

async function readClaudeCredentialRecord() {
	const cacheFile = Bun.file(getClaudeCredentialCachePath());

	if (await cacheFile.exists()) {
		const cachedRoot = (await cacheFile.json()) as ClaudeOAuthCredentials;
		const cached = cachedRoot.claudeAiOauth ? readCredentialRecord(cachedRoot.claudeAiOauth) : null;

		if (cached) {
			return cached;
		}
	}

	const fileCredentials = await readClaudeCredentialsFile();
	return fileCredentials ? readCredentialRecord(fileCredentials) : null;
}

async function writeClaudeCredentialRecord(record: ClaudeCredentialRecord) {
	const payload = JSON.stringify(
		{
			claudeAiOauth: {
				accessToken: record.accessToken,
				refreshToken: record.refreshToken,
				expiresAt: record.expiresAt,
				scopes: record.scopes,
				rateLimitTier: record.rateLimitTier,
			},
		},
		null,
		2,
	);
	await Bun.write(getClaudeCredentialCachePath(), `${payload}\n`);
}

async function refreshClaudeCredentialRecord(record: ClaudeCredentialRecord) {
	if (!record.refreshToken) {
		return null;
	}

	const response = await fetch(CLAUDE_OAUTH_TOKEN_URL, {
		body: new URLSearchParams({
			client_id: CLAUDE_OAUTH_CLIENT_ID,
			grant_type: "refresh_token",
			refresh_token: record.refreshToken,
		}),
		headers: {
			Accept: "application/json",
			"Content-Type": "application/x-www-form-urlencoded",
		},
		method: "POST",
	});

	if (!response.ok) {
		throw new Error(`Claude OAuth refresh failed: HTTP ${response.status}`);
	}

	const parsed = (await response.json()) as ClaudeTokenRefreshResponse;
	const accessToken = readString(parsed.access_token);
	const expiresIn = readNumber(parsed.expires_in);

	if (!accessToken || expiresIn === null) {
		throw new Error("Claude OAuth refresh failed: invalid response");
	}

	const nextRecord = {
		...record,
		accessToken,
		refreshToken: readString(parsed.refresh_token) ?? record.refreshToken,
		expiresAt: Date.now() + expiresIn * 1_000,
	} satisfies ClaudeCredentialRecord;

	await writeClaudeCredentialRecord(nextRecord);
	return nextRecord;
}

async function readClaudeAccessToken() {
	const record = await readClaudeCredentialRecord();

	if (!record || !record.scopes.includes("user:profile")) {
		return null;
	}

	if (record.expiresAt !== null && record.expiresAt <= Date.now()) {
		const refreshed = await refreshClaudeCredentialRecord(record);
		return refreshed?.accessToken ?? null;
	}

	return record.accessToken;
}

async function getClaudeVersion() {
	if (!claudeVersionPromise) {
		claudeVersionPromise = (async () => {
			const command = Bun.spawn([getClaudeBin(), "--version"], {
				stdout: "pipe",
				stderr: "ignore",
			});
			const output = await new Response(command.stdout).text();
			const version = output.trim().split(/\s+/)[0];
			return version.length > 0 ? version : FALLBACK_CLAUDE_VERSION;
		})();
	}

	return claudeVersionPromise;
}

export function mapClaudeUsageResponse(parsed: ClaudeUsageResponse) {
	return [
		mapUsageWindow("five_hour", parsed.five_hour),
		mapUsageWindow("weekly", parsed.seven_day),
	].filter((limit): limit is SessionLimit => limit !== null);
}

async function fetchClaudeUsageLimits() {
	const accessToken = await readClaudeAccessToken();

	if (!accessToken) {
		return [];
	}

	const response = await fetch(CLAUDE_USAGE_URL, {
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${accessToken}`,
			"anthropic-beta": CLAUDE_USAGE_BETA,
			"User-Agent": `claude-code/${await getClaudeVersion()}`,
		},
	});

	if (!response.ok) {
		throw new Error(`Claude usage fetch failed: HTTP ${response.status}`);
	}

	const parsed = (await response.json()) as ClaudeUsageResponse;
	return mapClaudeUsageResponse(parsed);
}

export async function refreshClaudeProviderLimits(force = false) {
	if (!force && Date.now() - lastClaudeUsageRefreshTime < CLAUDE_USAGE_REFRESH_INTERVAL) {
		return;
	}

	if (claudeUsageRefreshPromise) {
		return claudeUsageRefreshPromise;
	}

	claudeUsageRefreshPromise = (async () => {
		try {
			for (const limit of await fetchClaudeUsageLimits()) {
				sessionStore.saveProviderLimit("claude", limit);
			}
		} catch (error) {
			console.warn(
				"Note: Claude usage refresh failed:",
				error instanceof Error ? error.message : String(error),
			);
		} finally {
			lastClaudeUsageRefreshTime = Date.now();
			claudeUsageRefreshPromise = null;
		}
	})();

	return claudeUsageRefreshPromise;
}
