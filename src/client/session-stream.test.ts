import { describe, expect, test } from "bun:test";
import {
	formatSessionLimitLabel,
	formatSessionLimitUsage,
	copyToClipboard,
	getStreamEditDiffs,
	getToolOutput,
	hasMixedAssistantModels,
	getSidebarMeta,
	getSessionHeaderBadges,
	groupStream,
	orderSessionLimits,
	readToolResultContent,
	streamToMarkdown,
} from "~/client/session-stream";

describe("session limits", () => {
	test("deduplicates seven_day when weekly is present", () => {
		expect(
			orderSessionLimits([
				{
					isUsingOverage: null,
					window: "seven_day",
					resetsAt: 1,
					utilization: null,
					status: "allowed_warning",
				},
				{
					isUsingOverage: null,
					window: "weekly",
					resetsAt: 2,
					utilization: 42,
					status: "active",
				},
			]),
		).toEqual([
			{
				isUsingOverage: null,
				window: "weekly",
				resetsAt: 2,
				utilization: 42,
				status: "active",
			},
		]);
	});

	test("labels lone seven_day limits as weekly and hides raw status usage text", () => {
		expect(formatSessionLimitLabel("seven_day")).toBe("Weekly");
		expect(
			formatSessionLimitUsage({
				isUsingOverage: null,
				window: "seven_day",
				resetsAt: 1,
				utilization: null,
				status: "allowed_warning",
			}),
		).toBeNull();
	});
});

describe("getSessionHeaderBadges", () => {
	test("skips model badge and shows usage badges", () => {
		const badges = getSessionHeaderBadges({
			usage: {
				inputTokens: 12,
				outputTokens: 4,
				cacheReadInputTokens: 1200,
				cacheCreationInputTokens: 600,
				costUsd: 0.045784,
				model: "claude-opus-4-6[1m]",
			},
		});

		expect(badges).toEqual([
			{
				key: "in:12",
				label: "12",
				visibility: "xl",
			},
			{
				key: "out:4",
				label: "4",
				visibility: "xl",
			},
			{
				key: "cache-read:1200",
				label: "1,200",
				visibility: "xl",
			},
			{
				key: "cache-write:600",
				label: "600",
				visibility: "xl",
			},
			{
				key: "cost:0.045784",
				label: "$0.046",
				visibility: "xl",
			},
		]);
	});

	test("skips the model badge when the session has no model", () => {
		const badges = getSessionHeaderBadges({
			usage: {
				inputTokens: 1,
				outputTokens: 2,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
				costUsd: null,
				model: null,
			},
		});

		expect(badges).toEqual([
			{
				key: "in:1",
				label: "1",
				visibility: "xl",
			},
			{
				key: "out:2",
				label: "2",
				visibility: "xl",
			},
		]);
	});
});

describe("getStreamEditDiffs", () => {
	test("includes completed edit calls", () => {
		const diffs = getStreamEditDiffs([
			{
				id: "call-1",
				sessionId: "session-1",
				sequence: 1,
				kind: "tool-call",
				summary: "Edit file",
				data: {
					toolName: "Edit",
					toolUseId: "tool-1",
					input: {
						file_path: "/tmp/demo.ts",
						old_string: "a\nb",
						new_string: "a\nb\nc",
					},
				},
				rawProviderEvent: null,
				createTime: 1,
			},
			{
				id: "result-1",
				sessionId: "session-1",
				sequence: 2,
				kind: "tool-result",
				summary: "Edited file",
				data: {
					toolUseId: "tool-1",
					content: "ok",
					isError: false,
				},
				rawProviderEvent: null,
				createTime: 2,
			},
		]);

		expect(diffs.get("/tmp/demo.ts")).toEqual({
			added: 3,
			removed: 2,
			edits: [{ oldString: "a\nb", newString: "a\nb\nc" }],
		});
	});

	test("skips pending edit calls until they have a result", () => {
		const diffs = getStreamEditDiffs([
			{
				id: "call-1",
				sessionId: "session-1",
				sequence: 1,
				kind: "tool-call",
				summary: "Edit file",
				data: {
					toolName: "Edit",
					toolUseId: "tool-1",
					input: {
						file_path: "/tmp/demo.ts",
						old_string: "a",
						new_string: "b",
					},
				},
				rawProviderEvent: null,
				createTime: 1,
			},
		]);

		expect(diffs.size).toBe(0);
	});

	test("skips failed edit calls", () => {
		const diffs = getStreamEditDiffs([
			{
				id: "call-1",
				sessionId: "session-1",
				sequence: 1,
				kind: "tool-call",
				summary: "Edit file",
				data: {
					toolName: "Edit",
					toolUseId: "tool-1",
					input: {
						file_path: "/tmp/demo.ts",
						old_string: "a",
						new_string: "b",
					},
				},
				rawProviderEvent: null,
				createTime: 1,
			},
			{
				id: "result-1",
				sessionId: "session-1",
				sequence: 2,
				kind: "tool-result",
				summary: "Edit failed",
				data: {
					toolUseId: "tool-1",
					content: "Permission denied",
					isError: true,
				},
				rawProviderEvent: null,
				createTime: 2,
			},
		]);

		expect(diffs.size).toBe(0);
	});
});

describe("groupStream", () => {
	test("pairs tool results by toolUseId across intervening events", () => {
		const grouped = groupStream([
			{
				id: "call-1",
				sessionId: "session-1",
				sequence: 1,
				kind: "tool-call",
				summary: "Bash",
				data: {
					toolName: "Bash",
					toolUseId: "tool-1",
				},
				rawProviderEvent: null,
				createTime: 1,
			},
			{
				id: "text-1",
				sessionId: "session-1",
				sequence: 2,
				kind: "text",
				summary: "Assistant message",
				data: {
					role: "assistant",
					text: "Working...",
				},
				rawProviderEvent: null,
				createTime: 2,
			},
			{
				id: "result-1",
				sessionId: "session-1",
				sequence: 3,
				kind: "tool-result",
				summary: "Tool result",
				data: {
					toolUseId: "tool-1",
					content: "ok",
					isError: false,
				},
				rawProviderEvent: null,
				createTime: 3,
			},
		]);

		expect(grouped).toHaveLength(2);
		expect(grouped[0]).toMatchObject({
			type: "tool",
			call: {
				id: "call-1",
			},
			result: {
				id: "result-1",
			},
		});
		expect(grouped[1]).toMatchObject({
			type: "assistant-text-run",
			entries: [{ id: "text-1" }],
		});
	});

	test("keeps collapsing consecutive partial tool calls before the result arrives", () => {
		const grouped = groupStream([
			{
				id: "call-1",
				sessionId: "session-1",
				sequence: 1,
				kind: "tool-call",
				summary: "Read",
				data: {
					toolName: "Read",
					toolUseId: "tool-1",
					inputJson: '{"file_path":"/tmp/a"}',
				},
				rawProviderEvent: null,
				createTime: 1,
			},
			{
				id: "call-2",
				sessionId: "session-1",
				sequence: 2,
				kind: "tool-call",
				summary: "Read",
				data: {
					toolName: "Read",
					toolUseId: "tool-1",
					input: {
						file_path: "/tmp/a",
					},
				},
				rawProviderEvent: null,
				createTime: 2,
			},
			{
				id: "result-1",
				sessionId: "session-1",
				sequence: 3,
				kind: "tool-result",
				summary: "Tool result",
				data: {
					toolUseId: "tool-1",
					content: "ok",
				},
				rawProviderEvent: null,
				createTime: 3,
			},
		]);

		expect(grouped).toEqual([
			{
				type: "tool",
				call: expect.objectContaining({ id: "call-2" }),
				result: expect.objectContaining({ id: "result-1" }),
			},
		]);
	});

	test("matches specific tool results to the call with the same toolUseId", () => {
		const grouped = groupStream([
			{
				id: "call-1",
				sessionId: "session-1",
				sequence: 1,
				kind: "tool-call",
				summary: "Read",
				data: {
					toolName: "Read",
					toolUseId: null,
				},
				rawProviderEvent: null,
				createTime: 1,
			},
			{
				id: "call-2",
				sessionId: "session-1",
				sequence: 2,
				kind: "tool-call",
				summary: "Bash",
				data: {
					toolName: "Bash",
					toolUseId: "tool-2",
				},
				rawProviderEvent: null,
				createTime: 2,
			},
			{
				id: "result-1",
				sessionId: "session-1",
				sequence: 3,
				kind: "tool-result",
				summary: "Tool result",
				data: {
					toolUseId: "tool-2",
					content: "first",
				},
				rawProviderEvent: null,
				createTime: 3,
			},
			{
				id: "result-2",
				sessionId: "session-1",
				sequence: 4,
				kind: "tool-result",
				summary: "Tool result",
				data: {
					toolUseId: "tool-2",
					content: "second",
				},
				rawProviderEvent: null,
				createTime: 4,
			},
		]);

		expect(grouped[0]).toMatchObject({
			type: "tool",
			call: { id: "call-1" },
			result: null,
		});
		expect(grouped[1]).toMatchObject({
			type: "tool",
			call: { id: "call-2" },
			result: { id: "result-1" },
		});
	});

	test("drops consecutive duplicate thinking events", () => {
		const grouped = groupStream([
			{
				id: "thinking-1",
				sessionId: "session-1",
				sequence: 1,
				kind: "text",
				summary: "Thinking",
				data: {
					role: "thinking",
					text: "step through the diff",
				},
				rawProviderEvent: null,
				createTime: 1,
			},
			{
				id: "thinking-2",
				sessionId: "session-1",
				sequence: 2,
				kind: "text",
				summary: "Thinking",
				data: {
					role: "thinking",
					text: "step through the diff",
				},
				rawProviderEvent: null,
				createTime: 2,
			},
		]);

		expect(grouped).toEqual([
			{
				type: "single",
				entry: expect.objectContaining({
					id: "thinking-1",
				}),
			},
		]);
	});

	test("hides rate limit system events from the grouped transcript", () => {
		const grouped = groupStream([
			{
				id: "limit-1",
				sessionId: "session-1",
				sequence: 1,
				kind: "system",
				summary: "Rate limit update",
				data: {
					limit: {
						status: "allowed",
						window: "five_hour",
					},
				},
				rawProviderEvent: null,
				createTime: 1,
			},
			{
				id: "assistant-1",
				sessionId: "session-1",
				sequence: 2,
				kind: "text",
				summary: "Assistant message",
				data: {
					role: "assistant",
					text: "still here",
				},
				rawProviderEvent: null,
				createTime: 2,
			},
		]);

		expect(grouped).toEqual([
			{
				type: "assistant-text-run",
				entries: [expect.objectContaining({ id: "assistant-1" })],
			},
		]);
	});

	test("hides Claude completion state events from the grouped transcript", () => {
		const grouped = groupStream([
			{
				id: "state-1",
				sessionId: "session-1",
				sequence: 1,
				kind: "state",
				summary: "Claude run complete",
				data: {},
				rawProviderEvent: null,
				createTime: 1,
			},
			{
				id: "assistant-1",
				sessionId: "session-1",
				sequence: 2,
				kind: "text",
				summary: "Assistant message",
				data: {
					role: "assistant",
					text: "still here",
				},
				rawProviderEvent: null,
				createTime: 2,
			},
		]);

		expect(grouped).toEqual([
			{
				type: "assistant-text-run",
				entries: [expect.objectContaining({ id: "assistant-1" })],
			},
		]);
	});
});

describe("hasMixedAssistantModels", () => {
	test("returns false for a single assistant model", () => {
		const grouped = groupStream([
			{
				id: "text-1",
				sessionId: "session-1",
				sequence: 1,
				kind: "text",
				summary: "Assistant message",
				data: {
					role: "assistant",
					text: "first",
					model: "claude-sonnet-4-5",
				},
				rawProviderEvent: null,
				createTime: 1,
			},
			{
				id: "text-2",
				sessionId: "session-1",
				sequence: 2,
				kind: "text",
				summary: "Assistant message",
				data: {
					role: "assistant",
					text: "second",
					model: "claude-sonnet-4-5",
				},
				rawProviderEvent: null,
				createTime: 2,
			},
		]);

		expect(hasMixedAssistantModels(grouped)).toBe(false);
	});

	test("returns true when assistant model changes across the transcript", () => {
		const grouped = groupStream([
			{
				id: "text-1",
				sessionId: "session-1",
				sequence: 1,
				kind: "text",
				summary: "Assistant message",
				data: {
					role: "assistant",
					text: "first",
					model: "claude-sonnet-4-5",
				},
				rawProviderEvent: null,
				createTime: 1,
			},
			{
				id: "user-1",
				sessionId: "session-1",
				sequence: 2,
				kind: "text",
				summary: "User message",
				data: {
					role: "user",
					text: "switch",
				},
				rawProviderEvent: null,
				createTime: 2,
			},
			{
				id: "text-2",
				sessionId: "session-1",
				sequence: 3,
				kind: "text",
				summary: "Assistant message",
				data: {
					role: "assistant",
					text: "second",
					model: "claude-opus-4-1",
				},
				rawProviderEvent: null,
				createTime: 3,
			},
		]);

		expect(hasMixedAssistantModels(grouped)).toBe(true);
	});
});

describe("getSidebarMeta", () => {
	test("shows cwd for running sessions", () => {
		expect(
			getSidebarMeta(
				{
					allowedTools: [],
					archived: false,
					createTime: 0,
					cwd: "/tmp/project",
					id: "session-1",
					imported: false,
					projectId: null,
					model: null,
					effort: null,
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
					title: "Run",
					updateTime: 120_000,
					usage: null,
				},
				180_000,
			),
		).toBe("/tmp/project");
	});

	test("shows relative time for idle sessions", () => {
		expect(
			getSidebarMeta(
				{
					allowedTools: [],
					archived: false,
					createTime: 0,
					cwd: "/tmp/project",
					id: "session-1",
					imported: false,
					projectId: null,
					model: null,
					effort: null,
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
					title: "Done",
					updateTime: 120_000,
					usage: null,
				},
				180_000,
			),
		).toBe("1m ago · /tmp/project");
	});

	test("shows cwd for waiting sessions", () => {
		expect(
			getSidebarMeta(
				{
					allowedTools: [],
					archived: false,
					createTime: 0,
					cwd: "/tmp/project",
					id: "session-1",
					imported: false,
					projectId: null,
					model: null,
					effort: null,
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
					title: "Queued",
					updateTime: 120_000,
					usage: null,
				},
				180_000,
			),
		).toBe("waiting approval · /tmp/project");
	});
});

describe("readToolResultContent", () => {
	test("reads stored tool-result content", () => {
		expect(
			readToolResultContent({
				id: "result-1",
				sessionId: "session-1",
				sequence: 1,
				kind: "tool-result",
				summary: "Tool result",
				data: {
					content: "bash output",
				},
				rawProviderEvent: null,
				createTime: 1,
			}),
		).toBe("bash output");
	});
});

describe("streamToMarkdown", () => {
	test("renders assistant runs and tool results as markdown", () => {
		expect(
			streamToMarkdown([
				{
					id: "user-1",
					sessionId: "session-1",
					sequence: 1,
					kind: "text",
					summary: "User prompt",
					data: {
						role: "user",
						text: "Explain this diff",
					},
					rawProviderEvent: null,
					createTime: 1,
				},
				{
					id: "assistant-1",
					sessionId: "session-1",
					sequence: 2,
					kind: "text",
					summary: "Assistant reply",
					data: {
						role: "assistant",
						text: "Working on it.",
					},
					rawProviderEvent: null,
					createTime: 2,
				},
				{
					id: "call-1",
					sessionId: "session-1",
					sequence: 3,
					kind: "tool-call",
					summary: "Read file",
					data: {
						toolName: "Read",
						toolUseId: "tool-1",
						input: {
							file_path: "/tmp/demo.ts",
						},
					},
					rawProviderEvent: null,
					createTime: 3,
				},
				{
					id: "result-1",
					sessionId: "session-1",
					sequence: 4,
					kind: "tool-result",
					summary: "Tool output",
					data: {
						toolUseId: "tool-1",
						content: "const value = 1;",
						isError: false,
					},
					rawProviderEvent: null,
					createTime: 4,
				},
			]),
		).toBe(
			[
				"## User",
				"",
				"Explain this diff",
				"",
				"## Assistant",
				"",
				"Working on it.",
				"",
				"### Read: `/tmp/demo.ts`",
				"",
				"```",
				"const value = 1;",
				"```",
			].join("\n"),
		);
	});

	test("labels thinking blocks separately in markdown", () => {
		expect(
			streamToMarkdown([
				{
					id: "thinking-1",
					sessionId: "session-1",
					sequence: 1,
					kind: "text",
					summary: "Thinking",
					data: {
						role: "thinking",
						text: "Need to inspect the parser first.",
					},
					rawProviderEvent: null,
					createTime: 1,
				},
			]),
		).toBe("## Thinking\n\nNeed to inspect the parser first.");
	});
});

describe("getToolOutput", () => {
	test("prefers Write input content for successful writes", () => {
		expect(
			getToolOutput(
				{
					id: "call-1",
					sessionId: "session-1",
					sequence: 1,
					kind: "tool-call",
					summary: "Write file",
					data: {
						toolName: "Write",
						input: {
							file_path: "/tmp/demo.ts",
							content: "console.log('ok');",
						},
					},
					rawProviderEvent: null,
					createTime: 1,
				},
				{
					id: "result-1",
					sessionId: "session-1",
					sequence: 2,
					kind: "tool-result",
					summary: "Wrote file",
					data: {
						content: "File written",
						isError: false,
					},
					rawProviderEvent: null,
					createTime: 2,
				},
			),
		).toBe("console.log('ok');");
	});

	test("shows tool error output for failed writes", () => {
		expect(
			getToolOutput(
				{
					id: "call-1",
					sessionId: "session-1",
					sequence: 1,
					kind: "tool-call",
					summary: "Write file",
					data: {
						toolName: "Write",
						input: {
							file_path: "/tmp/demo.ts",
							content: "console.log('ok');",
						},
					},
					rawProviderEvent: null,
					createTime: 1,
				},
				{
					id: "result-1",
					sessionId: "session-1",
					sequence: 2,
					kind: "tool-result",
					summary: "Write failed",
					data: {
						content: "Permission denied",
						isError: true,
					},
					rawProviderEvent: null,
					createTime: 2,
				},
			),
		).toBe("Permission denied");
	});
});

describe("copyToClipboard", () => {
	test("uses navigator clipboard when available", async () => {
		const calls: string[] = [];
		const originalNavigator = globalThis.navigator;

		Object.defineProperty(globalThis, "navigator", {
			configurable: true,
			value: {
				clipboard: {
					writeText(text: string) {
						calls.push(text);
						return Promise.resolve();
					},
				},
			},
		});

		try {
			await copyToClipboard("copied text");
		} finally {
			Object.defineProperty(globalThis, "navigator", {
				configurable: true,
				value: originalNavigator,
			});
		}

		expect(calls).toEqual(["copied text"]);
	});

	test("falls back to execCommand when navigator.clipboard is unavailable", async () => {
		const originalNavigator = globalThis.navigator;
		const originalDocument = globalThis.document;

		const appended: HTMLElement[] = [];
		const removed: HTMLElement[] = [];
		let execCalled = false;

		Object.defineProperty(globalThis, "navigator", {
			configurable: true,
			value: { clipboard: undefined },
		});

		const mockTextarea = {
			value: "",
			style: {} as CSSStyleDeclaration,
			select: () => {},
		};

		Object.defineProperty(globalThis, "document", {
			configurable: true,
			value: {
				createElement: (tag: string) => {
					expect(tag).toBe("textarea");
					return mockTextarea;
				},
				body: {
					appendChild: (el: HTMLElement) => appended.push(el),
					removeChild: (el: HTMLElement) => removed.push(el),
				},
				execCommand: (cmd: string) => {
					expect(cmd).toBe("copy");
					execCalled = true;
					return true;
				},
			},
		});

		try {
			await copyToClipboard("fallback text");
		} finally {
			Object.defineProperty(globalThis, "navigator", {
				configurable: true,
				value: originalNavigator,
			});
			Object.defineProperty(globalThis, "document", {
				configurable: true,
				value: originalDocument,
			});
		}

		expect(mockTextarea.value).toBe("fallback text");
		expect(execCalled).toBe(true);
		expect(appended.length).toBe(1);
		expect(removed.length).toBe(1);
	});
});
