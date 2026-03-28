import { describe, expect, test } from "bun:test";
import {
	getDocumentTitle,
	getSessionCompletionNotificationBody,
	shouldInterruptOnCtrlC,
	shouldNotifySessionCompletion,
} from "~/client/app-shell";

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

describe("shouldNotifySessionCompletion", () => {
	test("notifies when an active session becomes idle", () => {
		expect(shouldNotifySessionCompletion("running", "idle")).toBe(true);
	});

	test("does not notify when an active session becomes waiting", () => {
		expect(shouldNotifySessionCompletion("running", "waiting")).toBe(false);
	});

	test("does not notify on the first observed status", () => {
		expect(shouldNotifySessionCompletion(null, "idle")).toBe(false);
	});
});

describe("getSessionCompletionNotificationBody", () => {
	test("uses a failure message for failed sessions", () => {
		expect(
			getSessionCompletionNotificationBody({
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
		).toBe("Failed: boom");
	});

	test("uses the generic completion message for successful sessions", () => {
		expect(
			getSessionCompletionNotificationBody({
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
				status: "idle",
				statusDetail: {
					attempt: null,
					blockReason: null,
					message: null,
					nextRetryTime: null,
					waitKind: null,
				},
				title: "Done session",
				updateTime: 0,
				usage: null,
			}),
		).toBe("Task complete");
	});
});

describe("shouldInterruptOnCtrlC", () => {
	test("interrupts running sessions on plain Ctrl+C with no selection", () => {
		expect(
			shouldInterruptOnCtrlC(
				{
					key: "c",
					ctrlKey: true,
					shiftKey: false,
					altKey: false,
					metaKey: false,
				},
				"",
				{
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
				},
			),
		).toBe(true);
	});

	test("does not interrupt when text is selected", () => {
		expect(
			shouldInterruptOnCtrlC(
				{
					key: "c",
					ctrlKey: true,
					shiftKey: false,
					altKey: false,
					metaKey: false,
				},
				"copied text",
				null,
			),
		).toBe(false);
	});
});
