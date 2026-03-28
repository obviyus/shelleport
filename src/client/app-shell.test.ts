import { describe, expect, test } from "bun:test";
import { getDocumentTitle } from "~/client/app-shell";

describe("getDocumentTitle", () => {
	test("uses the base title when no session is selected", () => {
		expect(getDocumentTitle(null)).toBe("shelleport");
	});

	test("prefixes running sessions with the live indicator", () => {
		expect(
			getDocumentTitle({
				allowedTools: [],
				archived: false,
				createTime: 0,
				cwd: "/tmp/project",
				id: "session-1",
				imported: false,
				lastEventSequence: 0,
				permissionMode: "default",
				pid: null,
				pinned: false,
				provider: "claude",
				providerSessionRef: null,
				queuedInputCount: 0,
				status: "running",
				statusDetail: {
					attempt: null,
					blockReason: null,
					message: null,
					nextRetryTime: null,
					waitKind: null,
				},
				title: "Build session",
				updateTime: 0,
				usage: null,
			}),
		).toBe("● Build session — shelleport");
	});

	test("prefixes waiting sessions with the approval indicator", () => {
		expect(
			getDocumentTitle({
				allowedTools: [],
				archived: false,
				createTime: 0,
				cwd: "/tmp/project",
				id: "session-1",
				imported: false,
				lastEventSequence: 0,
				permissionMode: "default",
				pid: null,
				pinned: false,
				provider: "claude",
				providerSessionRef: null,
				queuedInputCount: 0,
				status: "waiting",
				statusDetail: {
					attempt: null,
					blockReason: null,
					message: null,
					nextRetryTime: null,
					waitKind: "approval",
				},
				title: "Review session",
				updateTime: 0,
				usage: null,
			}),
		).toBe("◉ Review session — shelleport");
	});

	test("prefixes failed sessions with the failure indicator", () => {
		expect(
			getDocumentTitle({
				allowedTools: [],
				archived: false,
				createTime: 0,
				cwd: "/tmp/project",
				id: "session-1",
				imported: false,
				lastEventSequence: 0,
				permissionMode: "default",
				pid: null,
				pinned: false,
				provider: "claude",
				providerSessionRef: null,
				queuedInputCount: 0,
				status: "failed",
				statusDetail: {
					attempt: null,
					blockReason: null,
					message: "boom",
					nextRetryTime: null,
					waitKind: null,
				},
				title: "Broken session",
				updateTime: 0,
				usage: null,
			}),
		).toBe("✗ Broken session — shelleport");
	});
});
