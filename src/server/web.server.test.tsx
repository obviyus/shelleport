import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SessionDetail, HostSession } from "~/shared/shelleport";

let dataDir = "";
let tempDir = "";
let buildAppBootData: typeof import("~/server/web.server").buildAppBootData;
let sessionBroker: typeof import("~/server/session-broker.server").sessionBroker;
let originalGetSessionDetail: typeof import("~/server/session-broker.server").sessionBroker.getSessionDetail;
let originalListSessions: typeof import("~/server/session-broker.server").sessionBroker.listSessions;
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
	tempDir = await mkdtemp(join(tmpdir(), "shelleport-web-test-"));
	dataDir = join(tempDir, "data");

	await Bun.$`mkdir -p ${dataDir}`.quiet();

	Bun.env.SHELLEPORT_DATA_DIR = dataDir;
	const auth = await import("~/server/auth.server");
	auth.setAdminToken("test-token");
	({ buildAppBootData } = await import("~/server/web.server"));
	({ sessionBroker } = await import("~/server/session-broker.server"));
	originalListSessions = sessionBroker.listSessions.bind(sessionBroker);
	originalGetSessionDetail = sessionBroker.getSessionDetail.bind(sessionBroker);
	sessionBroker.listSessions = () => [testSession];
	sessionBroker.getSessionDetail = (requestedSessionId) =>
		requestedSessionId === sessionId ? testSessionDetail : null;
});

afterAll(async () => {
	sessionBroker.listSessions = originalListSessions;
	sessionBroker.getSessionDetail = originalGetSessionDetail;

	if (tempDir) {
		await rm(tempDir, { force: true, recursive: true });
	}

	delete Bun.env.SHELLEPORT_DATA_DIR;
});

function request(pathname: string, authenticated = false) {
	return new Request(`http://localhost${pathname}`, {
		headers: authenticated
			? {
					Authorization: "Bearer test-token",
				}
			: undefined,
	});
}

describe("buildAppBootData", () => {
	test("returns login route for unauthenticated app pages", () => {
		const boot = buildAppBootData(request("/"), {
			defaultCwd: "/tmp/project",
			pathname: "/",
		});

		expect(boot.authenticated).toBe(false);
		expect(boot.route.kind).toBe("login");
		expect(boot.route.pathname).toBe("/login");
	});

	test("returns home route for authenticated login page", () => {
		const boot = buildAppBootData(request("/login", true), {
			defaultCwd: "/tmp/project",
			pathname: "/login",
		});

		expect(boot.authenticated).toBe(true);
		expect(boot.route.kind).toBe("home");
		expect(boot.route.pathname).toBe("/");
	});

	test("includes session detail for authenticated session route", () => {
		const boot = buildAppBootData(request(`/sessions/${sessionId}`, true), {
			defaultCwd: "/tmp/project",
			pathname: `/sessions/${sessionId}`,
		});

		expect(boot.authenticated).toBe(true);
		expect(boot.route.kind).toBe("session");
		if (boot.route.kind === "session") {
			expect(boot.route.params.sessionId).toBe(sessionId);
		}
		if (boot.authenticated) {
			expect(boot.sessionDetail?.session.id).toBe(sessionId);
		}
	});

	test("returns not-found route for missing authenticated session", () => {
		const boot = buildAppBootData(request("/sessions/missing", true), {
			defaultCwd: "/tmp/project",
			pathname: "/sessions/missing",
		});

		expect(boot.authenticated).toBe(true);
		expect(boot.route.kind).toBe("not-found");
		expect(boot.route.pathname).toBe("/sessions/missing");
	});
});
