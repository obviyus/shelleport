import { describe, expect, test } from "bun:test";
import {
	getDocumentTitle,
	getFirstRunReadiness,
	getNextPromptHistoryState,
	getPreviousPromptHistoryState,
	getSessionCompletionNotificationBody,
	getSessionListEmptyState,
	pushPromptHistory,
	shouldShowReconnectBanner,
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

describe("shouldShowReconnectBanner", () => {
	test("shows the banner when a loaded session is reconnecting", () => {
		expect(shouldShowReconnectBanner(false, "reconnecting")).toBe(true);
	});

	test("hides the banner while the session is still pending", () => {
		expect(shouldShowReconnectBanner(true, "reconnecting")).toBe(false);
	});
});

describe("getSessionListEmptyState", () => {
	test("uses a no-results message for filtered empty lists", () => {
		expect(getSessionListEmptyState("agent")).toEqual({
			actionLabel: null,
			message: 'No results for "agent"',
		});
	});

	test("uses the generic empty state when no search is active", () => {
		expect(getSessionListEmptyState("")).toEqual({
			actionLabel: "Create one",
			message: "No sessions",
		});
	});
});

describe("getFirstRunReadiness", () => {
	test("reports ready when Claude can create managed sessions", () => {
		expect(
			getFirstRunReadiness([
				{
					id: "claude",
					label: "Claude",
					status: "ready",
					statusDetail: null,
					capabilities: {
						canCreate: true,
						canResumeHistorical: true,
						canInterrupt: true,
						canTerminate: true,
						hasStructuredEvents: true,
						supportsApprovals: true,
						supportsQuestions: false,
						supportsAttachments: true,
						supportsFork: false,
						supportsWorktree: true,
						liveResume: "managed-only",
					},
				},
			]),
		).toEqual({
			canCreateManagedSession: true,
			claudeReady: true,
			claudeStatusDetail: null,
		});
	});

	test("surfaces Claude status detail when managed sessions are blocked", () => {
		expect(
			getFirstRunReadiness([
				{
					id: "claude",
					label: "Claude",
					status: "partial",
					statusDetail: "Claude CLI is not authenticated.",
					capabilities: {
						canCreate: true,
						canResumeHistorical: true,
						canInterrupt: true,
						canTerminate: true,
						hasStructuredEvents: true,
						supportsApprovals: true,
						supportsQuestions: false,
						supportsAttachments: true,
						supportsFork: false,
						supportsWorktree: true,
						liveResume: "managed-only",
					},
				},
			]),
		).toEqual({
			canCreateManagedSession: false,
			claudeReady: false,
			claudeStatusDetail: "Claude CLI is not authenticated.",
		});
	});
});

describe("prompt history helpers", () => {
	test("pushPromptHistory prepends the latest prompt and caps the list", () => {
		expect(pushPromptHistory(["older", "oldest"], "latest", 2)).toEqual(["latest", "older"]);
	});

	test("getPreviousPromptHistoryState enters history from the current draft", () => {
		expect(getPreviousPromptHistoryState(["older"], -1, "draft", true, "")).toEqual({
			historyIndex: 0,
			prompt: "older",
			savedDraft: "draft",
		});
	});

	test("getNextPromptHistoryState restores the saved draft at the end", () => {
		expect(getNextPromptHistoryState(["older"], 0, "draft")).toEqual({
			historyIndex: -1,
			prompt: "draft",
			savedDraft: "draft",
		});
	});
});
