import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	createClaudeBashToolRule,
	normalizeClaudeEvent,
	normalizeClaudeStreamEvent,
	parseClaudeHistoricalSession,
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
