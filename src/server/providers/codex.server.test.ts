import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	buildCodexPendingRequest,
	mapCodexItemCompleted,
	mapCodexItemStarted,
	mapCodexModel,
	mapCodexPlanNotification,
	mapCodexRateLimits,
	parseCodexHistoricalSession,
} from "~/server/providers/codex.server";

const tempPaths: string[] = [];
const tempDir = Bun.env.TMPDIR ?? "/tmp";

afterEach(async () => {
	for (const path of tempPaths.splice(0)) {
		await Bun.$`rm -f ${path}`.quiet();
	}
});

describe("mapCodexRateLimits", () => {
	test("maps primary and secondary Codex rate limit windows", () => {
		expect(
			mapCodexRateLimits({
				rateLimits: {
					primary: {
						usedPercent: 42,
						windowDurationMins: 300,
						resetsAt: 1778053081,
					},
					secondary: {
						usedPercent: 26,
						windowDurationMins: 10080,
						resetsAt: 1778578512,
					},
				},
			}),
		).toEqual([
			{
				isUsingOverage: null,
				resetsAt: 1778053081000,
				status: null,
				utilization: 42,
				window: "300m",
			},
			{
				isUsingOverage: null,
				resetsAt: 1778578512000,
				status: null,
				utilization: 26,
				window: "10080m",
			},
		]);
	});

	test("skips incomplete Codex rate limit windows", () => {
		expect(
			mapCodexRateLimits({
				rateLimits: {
					primary: { usedPercent: 42, windowDurationMins: 300 },
					secondary: null,
				},
			}),
		).toEqual([]);
	});
});

describe("mapCodexModel", () => {
	test("uses app-server display names", () => {
		expect(
			mapCodexModel({
				id: "gpt-5.3-codex-spark",
				displayName: "GPT-5.3-Codex-Spark",
				defaultReasoningEffort: "xhigh",
				supportedReasoningEfforts: [
					{ reasoningEffort: "low" },
					{ reasoningEffort: "medium" },
					{ reasoningEffort: "xhigh" },
				],
			}),
		).toEqual({
			defaultEffort: "max",
			id: "gpt-5.3-codex-spark",
			label: "GPT-5.3-Codex-Spark",
			supportedEfforts: ["low", "medium", "max"],
		});
	});
});

describe("mapCodexItem", () => {
	test("maps app-server image generation items", () => {
		expect(
			mapCodexItemStarted({
				id: "image-1",
				type: "imageGeneration",
				revisedPrompt: "A clean product screenshot",
				status: "inProgress",
			}),
		).toMatchObject({
			kind: "tool-call",
			summary: "A clean product screenshot",
			data: {
				toolName: "ImageGeneration",
				toolUseId: "image-1",
			},
		});

		expect(
			mapCodexItemCompleted({
				id: "image-1",
				type: "imageGeneration",
				status: "completed",
				savedPath: "/tmp/output.png",
			}),
		).toMatchObject({
			kind: "tool-result",
			summary: "Image generated",
			data: {
				isError: false,
				output: "/tmp/output.png",
				toolUseId: "image-1",
			},
		});
	});
});

describe("mapCodexPlanNotification", () => {
	test("falls back to plan steps when explanation is empty", () => {
		expect(
			mapCodexPlanNotification({
				explanation: "",
				plan: [
					{ step: "Inspect app-server schema", status: "completed" },
					{ step: "Map supported events", status: "inProgress" },
				],
			}),
		).toMatchObject({
			kind: "system",
			summary: "Plan updated",
			data: {
				text: "Inspect app-server schema\nMap supported events",
			},
		});
	});
});

describe("buildCodexPendingRequest", () => {
	test("renders managed network approvals as network access", () => {
		expect(
			buildCodexPendingRequest("request-1", {
				id: "rpc-1",
				method: "item/commandExecution/requestApproval",
				params: {
					itemId: "tool-1",
					networkApprovalContext: {
						host: "api.example.com",
						protocol: "https",
					},
					reason: "fetch package metadata",
				},
			}),
		).toMatchObject({
			blockReason: "permission",
			kind: "approval",
			prompt: "Allow Codex network access to https://api.example.com? fetch package metadata",
			data: {
				networkApprovalContext: {
					host: "api.example.com",
					protocol: "https",
				},
				requestId: "request-1",
				toolUseId: "tool-1",
			},
		});
	});
});

describe("parseCodexHistoricalSession", () => {
	test("reads metadata from a Codex jsonl file", async () => {
		const path = join(tempDir, `codex-history-${Bun.randomUUIDv7()}.jsonl`);
		tempPaths.push(path);
		await Bun.write(
			path,
			[
				JSON.stringify({
					type: "session_meta",
					payload: {
						id: "codex-session-1",
						cwd: "/tmp/codex",
						timestamp: "2026-03-26T00:00:00.000Z",
						originator: "codex_cli",
					},
				}),
			].join("\n"),
		);

		const session = await parseCodexHistoricalSession(path);

		expect(session).not.toBeNull();
		expect(session).toMatchObject({
			provider: "codex",
			providerSessionRef: "codex-session-1",
			cwd: "/tmp/codex",
		});
	});
});
