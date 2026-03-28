import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	createClaudeBashToolRule,
	filterClaudeStreamDuplicates,
	normalizeClaudeEvent,
	normalizeClaudeStreamEvent,
	parseClaudeHistoricalSession,
	updateClaudeStreamMergeState,
} from "~/server/providers/claude.server";

const tempPaths: string[] = [];
const tempDir = Bun.env.TMPDIR ?? "/tmp";

afterEach(async () => {
	for (const path of tempPaths.splice(0)) {
		await Bun.$`rm -f ${path}`.quiet();
	}
});

describe("createClaudeBashToolRule", () => {
	test("derives a narrow git subcommand rule", () => {
		expect(createClaudeBashToolRule("git commit --allow-empty -m test")).toBe("Bash(git commit:*)");
	});

	test("derives a single-token rule when the second token is a flag", () => {
		expect(createClaudeBashToolRule("rm -f forbidden.tmp")).toBe("Bash(rm:*)");
	});
});

describe("normalizeClaudeEvent", () => {
	test("maps text and tool calls", () => {
		const events = normalizeClaudeEvent({
			type: "assistant",
			message: {
				content: [
					{
						type: "text",
						text: "done",
					},
					{
						type: "tool_use",
						id: "tool-1",
						name: "Read",
						input: {
							file_path: "/tmp/example",
						},
					},
				],
			},
		});

		expect(events).toHaveLength(2);
		expect(events[0]).toMatchObject({
			type: "host-event",
			kind: "text",
		});
		expect(events[1]).toMatchObject({
			type: "host-event",
			kind: "tool-call",
		});
	});

	test("maps thinking content blocks", () => {
		const events = normalizeClaudeEvent({
			type: "assistant",
			message: {
				content: [
					{
						type: "thinking",
						thinking: "compare the last two events",
					},
				],
			},
		});

		expect(events).toEqual([
			expect.objectContaining({
				type: "host-event",
				kind: "text",
				data: expect.objectContaining({
					role: "thinking",
					text: "compare the last two events",
				}),
			}),
		]);
	});

	test("maps permission denials into approval requests", () => {
		const events = normalizeClaudeEvent({
			type: "result",
			subtype: "success",
			is_error: false,
			result: "blocked",
			permission_denials: [
				{
					tool_name: "Bash",
					tool_use_id: "tool-1",
					tool_input: {
						command: "git commit --allow-empty -m test",
						description: "Create empty commit",
					},
				},
			],
		});

		expect(events).toHaveLength(2);
		expect(events[1]).toMatchObject({
			type: "pending-request",
			kind: "approval",
			blockReason: "permission",
			data: {
				toolName: "Bash",
				toolUseId: "tool-1",
				toolRule: "Bash(git commit:*)",
			},
		});
	});

	test("classifies sandbox-blocked tool results", () => {
		const events = normalizeClaudeEvent({
			type: "user",
			message: {
				content: [
					{
						type: "tool_result",
						tool_use_id: "tool-1",
						content:
							"rm in '/tmp/x' was blocked. For security, Claude Code may only remove files from the allowed working directories for this session: '/tmp'.",
						is_error: true,
					},
				],
			},
		});

		expect(events[0]).toMatchObject({
			type: "host-event",
			kind: "tool-result",
			data: {
				blockReason: "sandbox",
			},
		});
	});

	test("maps rate-limit progress into retry status", () => {
		const events = normalizeClaudeEvent({
			type: "progress",
			data: {
				toolUseResult: "Request failed with status code 429, retrying in 7s (attempt 2)",
			},
		});

		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			type: "session-status",
			status: "retrying",
			detail: {
				message: "Request failed with status code 429, retrying in 7s (attempt 2)",
				attempt: 2,
			},
		});
		expect(events[0].type).toBe("session-status");
		if (events[0].type !== "session-status") {
			throw new Error("Expected session-status event");
		}
		expect(events[0].detail.nextRetryTime).toBeGreaterThan(Date.now());
	});

	test("maps assistant usage into session detail", () => {
		const events = normalizeClaudeEvent({
			type: "assistant",
			message: {
				model: "claude-opus-4-6",
				content: [
					{
						type: "text",
						text: "done",
					},
				],
				usage: {
					input_tokens: 3,
					output_tokens: 1,
					cache_read_input_tokens: 11338,
					cache_creation_input_tokens: 6400,
				},
			},
		});

		expect(events[0]).toMatchObject({
			type: "host-event",
			kind: "text",
			data: {
				usage: {
					inputTokens: 3,
					outputTokens: 1,
					cacheReadInputTokens: 11338,
					cacheCreationInputTokens: 6400,
					model: "claude-opus-4-6",
				},
			},
		});
	});

	test("maps rate limit event into session detail", () => {
		const events = normalizeClaudeEvent({
			type: "rate_limit_event",
			rate_limit_info: {
				status: "allowed",
				resetsAt: 1774623600,
				rateLimitType: "five_hour",
				isUsingOverage: false,
			},
		});

		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			type: "host-event",
			kind: "system",
			data: {
				limit: {
					status: "allowed",
					window: "five_hour",
					isUsingOverage: false,
				},
			},
		});
		expect(events[0].type).toBe("host-event");
		if (events[0].type !== "host-event") {
			throw new Error("Expected host-event");
		}
		expect(events[0].data.limit).toMatchObject({
			resetsAt: 1774623600 * 1000,
		});
	});

	test("maps structured api retries into retry status", () => {
		const events = normalizeClaudeEvent({
			type: "system",
			subtype: "api_retry",
			attempt: 2,
			retry_delay_ms: 1200,
			error_status: 529,
			error: "rate_limit",
		});

		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			type: "session-status",
			status: "retrying",
			detail: {
				attempt: 2,
				message: "529 rate_limit retry (attempt 2)",
			},
		});
		expect(events[0].type).toBe("session-status");
		if (events[0].type !== "session-status") {
			throw new Error("Expected session-status event");
		}
		expect(events[0].detail.nextRetryTime).toBeGreaterThan(Date.now());
	});

	test("maps partial assistant text deltas", () => {
		const events = normalizeClaudeStreamEvent({
			type: "stream_event",
			event: {
				type: "content_block_delta",
				index: 0,
				delta: {
					type: "text_delta",
					text: "par",
				},
			},
		});

		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			type: "host-event",
			kind: "text",
			data: {
				role: "assistant",
				text: "par",
				partial: true,
			},
		});
	});

	test("maps partial tool input deltas", () => {
		const state = new Map();

		const startEvents = normalizeClaudeStreamEvent(
			{
				type: "stream_event",
				event: {
					type: "content_block_start",
					index: 1,
					content_block: {
						type: "tool_use",
						id: "tool-1",
						name: "Bash",
						input: {},
					},
				},
			},
			state,
		);

		const deltaEvents = normalizeClaudeStreamEvent(
			{
				type: "stream_event",
				event: {
					type: "content_block_delta",
					index: 1,
					delta: {
						type: "input_json_delta",
						partial_json: '{"command":"ls"}',
					},
				},
			},
			state,
		);

		expect(startEvents).toHaveLength(1);
		expect(deltaEvents).toHaveLength(1);
		expect(deltaEvents[0]).toMatchObject({
			type: "host-event",
			kind: "tool-call",
			data: {
				toolName: "Bash",
				toolUseId: "tool-1",
				input: {
					command: "ls",
				},
				partial: true,
			},
		});
	});

	test("buffers thinking deltas until the block stops", () => {
		const state = new Map();

		expect(
			normalizeClaudeStreamEvent(
				{
					type: "stream_event",
					event: {
						type: "content_block_start",
						index: 1,
						content_block: {
							type: "thinking",
						},
					},
				},
				state,
			),
		).toEqual([]);

		expect(
			normalizeClaudeStreamEvent(
				{
					type: "stream_event",
					event: {
						type: "content_block_delta",
						index: 1,
						delta: {
							type: "thinking_delta",
							thinking: "first pass",
						},
					},
				},
				state,
			),
		).toEqual([]);

		expect(
			normalizeClaudeStreamEvent(
				{
					type: "stream_event",
					event: {
						type: "content_block_delta",
						index: 1,
						delta: {
							type: "thinking_delta",
							thinking: " then verify",
						},
					},
				},
				state,
			),
		).toEqual([]);

		expect(
			normalizeClaudeStreamEvent(
				{
					type: "stream_event",
					event: {
						type: "content_block_stop",
						index: 1,
					},
				},
				state,
			),
		).toEqual([
			expect.objectContaining({
				type: "host-event",
				kind: "text",
				data: expect.objectContaining({
					role: "thinking",
					text: "first pass then verify",
				}),
			}),
		]);
	});

	test("does not suppress later assistant thinking after a prior streamed block", () => {
		const mergeState = {
			contentStateByIndex: new Map(),
			partialToolUseIds: new Set<string>(),
			sawAssistantTextDelta: false,
			sawThinkingBlock: false,
		};

		updateClaudeStreamMergeState(mergeState, [
			{
				type: "host-event",
				kind: "text",
				summary: "Thinking",
				data: {
					role: "thinking",
					text: "streamed thinking",
				},
				rawProviderEvent: null,
			},
		]);

		expect(
			filterClaudeStreamDuplicates(
				{
					type: "assistant",
				},
				normalizeClaudeEvent({
					type: "assistant",
					message: {
						content: [
							{
								type: "thinking",
								thinking: "non-stream thinking",
							},
						],
					},
				}),
				{
					...mergeState,
					sawThinkingBlock: false,
				},
			),
		).toEqual([
			expect.objectContaining({
				type: "host-event",
				kind: "text",
				data: expect.objectContaining({
					role: "thinking",
					text: "non-stream thinking",
				}),
			}),
		]);
	});
});

describe("parseClaudeHistoricalSession", () => {
	test("reads cwd and preview from a Claude jsonl file", async () => {
		const path = join(tempDir, `claude-history-${Bun.randomUUIDv7()}.jsonl`);
		tempPaths.push(path);
		await Bun.write(
			path,
			[
				JSON.stringify({
					type: "user",
					cwd: "/tmp/workspace",
					sessionId: "session-1",
					timestamp: "2026-03-26T00:00:00.000Z",
					message: {
						content: "Audit this repository",
					},
				}),
			].join("\n"),
		);

		const session = await parseClaudeHistoricalSession(path);

		expect(session).not.toBeNull();
		expect(session).toMatchObject({
			provider: "claude",
			providerSessionRef: "session-1",
			cwd: "/tmp/workspace",
		});
	});
});
