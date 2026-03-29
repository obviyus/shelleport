import { describe, expect, test } from "bun:test";
import {
	getToolOutput,
	copyToClipboard,
	getSidebarMeta,
	getSessionHeaderBadges,
	groupStream,
	readToolResultContent,
	streamToMarkdown,
} from "~/client/session-stream";

describe("getSessionHeaderBadges", () => {
	test("puts the normalized model badge before usage badges", () => {
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
				key: "model:claude-opus-4-6[1m]",
				label: "claude-opus-4-6",
				title: "claude-opus-4-6[1m]",
				visibility: "lg",
			},
			{
				key: "in:12",
				label: "in 12",
				visibility: "xl",
			},
			{
				key: "out:4",
				label: "out 4",
				visibility: "xl",
			},
			{
				key: "cache-read:1200",
				label: "cache read 1,200",
				visibility: "xl",
			},
			{
				key: "cache-write:600",
				label: "cache write 600",
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
				label: "in 1",
				visibility: "xl",
			},
			{
				key: "out:2",
				label: "out 2",
				visibility: "xl",
			},
		]);
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

	test("matches specific tool results against the earliest eligible pending call", () => {
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
			result: { id: "result-1" },
		});
		expect(grouped[1]).toMatchObject({
			type: "tool",
			call: { id: "call-2" },
			result: { id: "result-2" },
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
		).toBe("1m ago");
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
	test("uses navigator clipboard directly", async () => {
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
});
