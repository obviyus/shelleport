import { describe, expect, test } from "bun:test";
import {
	getSessionHeaderBadges,
	groupStream,
	readToolResultContent,
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
	test("excludes rate limit system events from grouped output", () => {
		const grouped = groupStream([
			{
				id: "text-1",
				sessionId: "session-1",
				sequence: 1,
				kind: "text",
				summary: "Assistant message",
				data: { role: "assistant", text: "Hello" },
				rawProviderEvent: null,
				createTime: 1,
			},
			{
				id: "rate-1",
				sessionId: "session-1",
				sequence: 2,
				kind: "system",
				summary: "Rate limit update",
				data: {
					limit: {
						status: "active",
						resetsAt: null,
						window: "five_hour",
						isUsingOverage: false,
						utilization: 42,
					},
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
				data: { role: "assistant", text: "Done" },
				rawProviderEvent: null,
				createTime: 3,
			},
		]);

		expect(grouped).toHaveLength(2);
		expect(grouped[0]).toMatchObject({ type: "assistant-text-run" });
		expect(grouped[1]).toMatchObject({ type: "assistant-text-run" });

		const ids = grouped.flatMap((group) =>
			group.type === "assistant-text-run" ? group.entries.map((entry) => entry.id) : [],
		);

		expect(ids).not.toContain("rate-1");
	});

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
