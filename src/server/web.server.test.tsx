import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ClientAssets } from "~/server/client-assets.server";
import type { SessionDetail, HostSession } from "~/shared/shelleport";

let tempDir = "";
let clientAssets: ClientAssets;
let dataDir = "";
let handleWebRequest: typeof import("~/server/web.server").handleWebRequest;
let sessionBroker: typeof import("~/server/session-broker.server").sessionBroker;
const sessionId = "session-test";
const testSession: HostSession = {
	allowedTools: [],
	archived: false,
	createTime: 1,
	cwd: "/tmp/project",
	id: sessionId,
	imported: false,
	lastEventSequence: 0,
	permissionMode: "default",
	pid: null,
	provider: "claude",
	providerSessionRef: null,
	status: "idle",
	statusDetail: {
		attempt: null,
		blockReason: null,
		message: null,
		nextRetryTime: null,
		waitKind: null,
	},
	title: "Web test session",
	updateTime: 1,
};
const testSessionDetail: SessionDetail = {
	events: [],
	pendingRequests: [],
	session: testSession,
};

beforeAll(async () => {
	Bun.env.SHELLEPORT_ADMIN_TOKEN = "test-token";
	tempDir = await mkdtemp(join(tmpdir(), "shelleport-web-test-"));
	dataDir = join(tempDir, "data");
	const stylePath = join(tempDir, "client.css");
	const scriptPath = join(tempDir, "client.js");

	await Bun.$`mkdir -p ${dataDir}`.quiet();
	await Bun.write(stylePath, "body{background:black}");
	await Bun.write(scriptPath, "console.log('client')");

	clientAssets = {
		entryScriptPath: "/assets/client.js",
		files: [
			{
				cacheControl: "public, max-age=31536000, immutable",
				publicPath: "/assets/client.css",
				sourcePath: stylePath,
			},
			{
				cacheControl: "public, max-age=31536000, immutable",
				publicPath: "/assets/client.js",
				sourcePath: scriptPath,
			},
		],
		stylePaths: ["/assets/client.css"],
	};

	Bun.env.SHELLEPORT_DATA_DIR = dataDir;
	({ handleWebRequest } = await import("~/server/web.server"));
	({ sessionBroker } = await import("~/server/session-broker.server"));
	sessionBroker.listSessions = () => [testSession];
	sessionBroker.getSessionDetail = (requestedSessionId) =>
		requestedSessionId === sessionId ? testSessionDetail : null;
});

afterAll(async () => {
	if (tempDir) {
		await rm(tempDir, { force: true, recursive: true });
	}

	delete Bun.env.SHELLEPORT_ADMIN_TOKEN;
	delete Bun.env.SHELLEPORT_DATA_DIR;
});

async function request(pathname: string, init?: RequestInit) {
	return handleWebRequest(new Request(`http://localhost${pathname}`, init), {
		clientAssets,
		defaultCwd: "/tmp/project",
	});
}

describe("handleWebRequest", () => {
	test("serves embedded assets", async () => {
		const response = await request("/assets/client.js");

		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
		expect(await response.text()).toContain("console.log");
	});

	test("renders login shell", async () => {
		const response = await request("/login");
		const body = await response.text();

		expect(response.status).toBe(200);
		expect(body).toContain("window.__SHELLEPORT_BOOT__");
		expect(body).toContain('href="/assets/client.css"');
		expect(body).toContain('src="/assets/client.js"');
		expect(body).toContain("Paste admin token");
		expect(body).toContain('"kind":"login"');
	});

	test("redirects home shell without auth", async () => {
		const response = await request("/");

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe("/login");
	});

	test("redirects archived shell without auth", async () => {
		const response = await request("/archived");

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe("/login");
	});

	test("renders home shell with auth", async () => {
		const response = await request("/", {
			headers: {
				Cookie: "shelleport_admin=test-token",
			},
		});
		const body = await response.text();

		expect(response.status).toBe(200);
		expect(body).toContain('"kind":"home"');
		expect(body).toContain('"defaultCwd":"/tmp/project"');
		expect(body).toContain('"authenticated":true');
		expect(body).toContain('"title":"Web test session"');
	});

	test("renders session shell with auth", async () => {
		const response = await request(`/sessions/${sessionId}`, {
			headers: {
				Cookie: "shelleport_admin=test-token",
			},
		});
		const body = await response.text();

		expect(response.status).toBe(200);
		expect(body).toContain('"kind":"session"');
		expect(body).toContain(`"sessionId":"${sessionId}"`);
		expect(body).toContain('"sessionDetail":');
	});

	test("redirects logout and clears auth cookie", async () => {
		const response = await request("/logout");

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe("/login");
		expect(response.headers.get("Set-Cookie")).toContain("shelleport_admin=");
	});

	test("renders not found page with 404", async () => {
		const response = await request("/missing");
		const body = await response.text();

		expect(response.status).toBe(404);
		expect(body).toContain("Page not found");
		expect(body).toContain('"kind":"not-found"');
	});
});
