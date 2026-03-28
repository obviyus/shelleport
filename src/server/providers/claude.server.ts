import { basename } from "node:path";
import { getClaudeBin } from "~/server/config.server";
import type {
	HistoricalSession,
	HostSession,
	ProviderCapabilities,
	ProviderSummary,
	SessionLimit,
	SessionUsage,
} from "~/shared/shelleport";
import type {
	ProviderAdapter,
	ProviderAdapterEvent,
	ProviderAdapterRunInput,
} from "~/server/providers/provider.server";
import { listJsonlFiles, readHeadJsonl } from "~/server/providers/jsonl.server";

const decoder = new TextDecoder();

const claudeCapabilities: ProviderCapabilities = {
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
};

type ClaudePermissionDenial = {
	tool_name?: unknown;
	tool_use_id?: unknown;
	tool_input?: unknown;
};

type ClaudeRetryStatus = {
	message: string;
	attempt: number | null;
	nextRetryTime: number | null;
};

function parseTokenCount(value: unknown) {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function parseCost(value: unknown) {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseResetsAt(value: unknown) {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return null;
	}

	return value > 1_000_000_000_000 ? value : value * 1_000;
}

function parseClaudeUsage(rawEvent: Record<string, unknown>): SessionUsage | null {
	const message =
		rawEvent.message && typeof rawEvent.message === "object"
			? (rawEvent.message as Record<string, unknown>)
			: null;
	const usageSource =
		message?.usage && typeof message.usage === "object"
			? (message.usage as Record<string, unknown>)
			: rawEvent.usage && typeof rawEvent.usage === "object"
				? (rawEvent.usage as Record<string, unknown>)
				: null;

	if (!usageSource) {
		return null;
	}

	const modelUsage =
		rawEvent.modelUsage && typeof rawEvent.modelUsage === "object"
			? (rawEvent.modelUsage as Record<string, unknown>)
			: null;
	const firstModel = modelUsage ? Object.keys(modelUsage)[0] : null;

	return {
		inputTokens: parseTokenCount(usageSource.input_tokens),
		outputTokens: parseTokenCount(usageSource.output_tokens),
		cacheReadInputTokens: parseTokenCount(usageSource.cache_read_input_tokens),
		cacheCreationInputTokens: parseTokenCount(usageSource.cache_creation_input_tokens),
		costUsd: parseCost(rawEvent.total_cost_usd),
		model:
			typeof message?.model === "string"
				? message.model
				: typeof firstModel === "string"
					? firstModel
					: null,
	};
}

function parseClaudeLimit(rawEvent: Record<string, unknown>): SessionLimit | null {
	if (rawEvent.type !== "rate_limit_event") {
		return null;
	}

	const info =
		rawEvent.rate_limit_info && typeof rawEvent.rate_limit_info === "object"
			? (rawEvent.rate_limit_info as Record<string, unknown>)
			: null;

	if (!info) {
		return null;
	}

	return {
		status: typeof info.status === "string" ? info.status : null,
		resetsAt: parseResetsAt(info.resetsAt),
		window: typeof info.rateLimitType === "string" ? info.rateLimitType : null,
		isUsingOverage: typeof info.isUsingOverage === "boolean" ? info.isUsingOverage : null,
		utilization: null,
	};
}

function classifyClaudeBlockReason(content: string) {
	if (content.includes("This command requires approval")) {
		return "permission" as const;
	}

	if (content.includes("was blocked. For security")) {
		return "sandbox" as const;
	}

	return null;
}

function formatAttachmentLine(
	attachment: ProviderAdapterRunInput["attachments"][number],
	index: number,
	total: number,
) {
	const isImage = attachment.contentType.startsWith("image/");
	if (total === 1) {
		return isImage
			? `Use this image as context: ${attachment.path}`
			: `Use this file as context: ${attachment.path}`;
	}
	const label = isImage ? "Image" : "File";
	return `${label} ${index + 1} (${attachment.name}): ${attachment.path}`;
}

function formatClaudePrompt(prompt: string, attachments: ProviderAdapterRunInput["attachments"]) {
	if (attachments.length === 0) {
		return prompt;
	}

	const lines = attachments.map((attachment, index) =>
		formatAttachmentLine(attachment, index, attachments.length),
	);

	return prompt.trim().length === 0 ? lines.join("\n") : `${lines.join("\n")}\n\n${prompt}`;
}

function createClaudeCommand(input: ProviderAdapterRunInput) {
	const { session } = input;
	const command = [
		getClaudeBin(),
		"-p",
		"--verbose",
		"--include-partial-messages",
		"--output-format",
		"stream-json",
		"--permission-mode",
		session.permissionMode,
	];

	for (const toolRule of session.allowedTools) {
		command.push("--allowedTools", toolRule);
	}

	if (session.providerSessionRef) {
		command.push("-r", session.providerSessionRef);
	}

	command.push(formatClaudePrompt(input.prompt, input.attachments));

	return command;
}

function getMessageContent(rawEvent: Record<string, unknown>) {
	const message =
		rawEvent.message && typeof rawEvent.message === "object"
			? (rawEvent.message as Record<string, unknown>)
			: null;

	return Array.isArray(message?.content) ? message.content : [];
}

function getToolInputRecord(value: unknown) {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function getStringRecord(value: unknown) {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function parseRetryDelay(text: string) {
	const match = text.match(/retry(?:ing)?\s+in\s+(\d+)\s*(second|sec|s|minute|min|m)/i);

	if (!match) {
		return null;
	}

	const amount = Number(match[1]);

	if (!Number.isFinite(amount)) {
		return null;
	}

	return match[2].toLowerCase().startsWith("m") ? amount * 60_000 : amount * 1_000;
}

function parseClaudeRetryStatus(rawEvent: Record<string, unknown>): ClaudeRetryStatus | null {
	if (rawEvent.subtype === "api_retry") {
		const attempt = typeof rawEvent.attempt === "number" ? rawEvent.attempt : null;
		const delayMs =
			typeof rawEvent.retry_delay_ms === "number" && Number.isFinite(rawEvent.retry_delay_ms)
				? rawEvent.retry_delay_ms
				: null;
		const errorStatus =
			typeof rawEvent.error_status === "number" ? String(rawEvent.error_status) : null;
		const errorCode = typeof rawEvent.error === "string" ? rawEvent.error : null;
		const parts = [errorStatus, errorCode].filter(Boolean);

		return {
			message:
				parts.length === 0
					? `Retrying request${attempt === null ? "" : ` (attempt ${attempt})`}`
					: `${parts.join(" ")} retry${attempt === null ? "" : ` (attempt ${attempt})`}`,
			attempt,
			nextRetryTime: delayMs === null ? null : Date.now() + delayMs,
		};
	}

	const candidates: string[] = [];
	const message = getStringRecord(rawEvent.message);
	const data = getStringRecord(rawEvent.data);
	const nestedMessage = getStringRecord(data?.message);

	if (typeof rawEvent.result === "string") {
		candidates.push(rawEvent.result);
	}

	if (typeof rawEvent.error === "string") {
		candidates.push(rawEvent.error);
	}

	if (typeof data?.toolUseResult === "string") {
		candidates.push(data.toolUseResult);
	}

	if (typeof nestedMessage?.toolUseResult === "string") {
		candidates.push(nestedMessage.toolUseResult);
	}

	if (Array.isArray(message?.content)) {
		for (const item of message.content) {
			const contentItem = getStringRecord(item);

			if (typeof contentItem?.text === "string") {
				candidates.push(contentItem.text);
			}

			if (typeof contentItem?.content === "string") {
				candidates.push(contentItem.content);
			}
		}
	}

	for (const candidate of candidates) {
		const messageText = candidate.trim();
		const normalized = messageText.toLowerCase();

		if (
			!normalized.includes("429") &&
			!normalized.includes("rate limit") &&
			!normalized.includes("too many requests") &&
			!normalized.includes("overloaded")
		) {
			continue;
		}

		const attemptMatch = messageText.match(/attempt\s*#?\s*(\d+)/i);
		const delayMs = parseRetryDelay(messageText);

		return {
			message: messageText,
			attempt: attemptMatch ? Number(attemptMatch[1]) : null,
			nextRetryTime: delayMs === null ? null : Date.now() + delayMs,
		};
	}

	return null;
}

function tokenizeCommand(command: string) {
	return command.match(/(?:[^\s"'`]+|"[^"]*"|'[^']*'|`[^`]*`)+/g) ?? [];
}

export function createClaudeBashToolRule(command: string) {
	const tokens = tokenizeCommand(command).map((token) => token.replace(/^['"`]|['"`]$/g, ""));

	if (tokens.length === 0) {
		return null;
	}

	const prefixTokens = [tokens[0]];
	const secondToken = tokens[1];

	if (secondToken && !secondToken.startsWith("-")) {
		prefixTokens.push(secondToken);
	}

	return `Bash(${prefixTokens.join(" ")}:*)`;
}

export function createClaudeApprovalPrompt(toolName: string, toolInput: Record<string, unknown>) {
	if (toolName === "Bash" && typeof toolInput.command === "string") {
		return `Approve Bash command: ${toolInput.command}`;
	}

	return `Approve ${toolName}`;
}

export function createClaudeResumePrompt(toolName: string, toolInput: Record<string, unknown>) {
	if (toolName === "Bash" && typeof toolInput.command === "string") {
		return `The user approved this command: ${toolInput.command}. Retry it if still needed, then continue the task.`;
	}

	return `The user approved the blocked ${toolName} request. Retry it if still needed, then continue the task.`;
}

function normalizeClaudeResult(rawEvent: Record<string, unknown>) {
	const events: ProviderAdapterEvent[] = [
		{
			type: "host-event",
			kind: rawEvent.is_error === true ? "error" : "state",
			summary: rawEvent.is_error === true ? "Claude run failed" : "Claude run complete",
			data: {
				result: typeof rawEvent.result === "string" ? rawEvent.result : null,
				stopReason: typeof rawEvent.stop_reason === "string" ? rawEvent.stop_reason : null,
				durationMs: typeof rawEvent.duration_ms === "number" ? rawEvent.duration_ms : null,
			},
			rawProviderEvent: rawEvent,
		},
	];

	const permissionDenials = Array.isArray(rawEvent.permission_denials)
		? (rawEvent.permission_denials as ClaudePermissionDenial[])
		: [];

	for (const denial of permissionDenials) {
		const toolName = typeof denial.tool_name === "string" ? denial.tool_name : null;
		const toolUseId = typeof denial.tool_use_id === "string" ? denial.tool_use_id : null;
		const toolInput = getToolInputRecord(denial.tool_input);

		if (!toolName || !toolUseId) {
			continue;
		}

		events.push({
			type: "pending-request",
			kind: "approval",
			blockReason: "permission",
			prompt: createClaudeApprovalPrompt(toolName, toolInput),
			data: {
				toolName,
				toolUseId,
				toolInput,
				toolRule:
					toolName === "Bash" && typeof toolInput.command === "string"
						? createClaudeBashToolRule(toolInput.command)
						: toolName,
				resumePrompt: createClaudeResumePrompt(toolName, toolInput),
			},
		});
	}

	return events;
}

function tryParsePartialJsonRecord(text: string) {
	if (text.trim().length === 0) {
		return {};
	}

	try {
		const parsed = JSON.parse(text) as unknown;
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

type ClaudeStreamToolUseState = {
	id: string | null;
	inputJson: string;
	name: string;
};

export function normalizeClaudeStreamEvent(
	rawEvent: Record<string, unknown>,
	toolUseStateByIndex?: Map<number, ClaudeStreamToolUseState>,
): ProviderAdapterEvent[] {
	if (rawEvent.type !== "stream_event") {
		return [];
	}

	const event =
		rawEvent.event && typeof rawEvent.event === "object"
			? (rawEvent.event as Record<string, unknown>)
			: null;

	if (!event) {
		return [];
	}

	if (event.type === "content_block_start") {
		const contentBlock =
			event.content_block && typeof event.content_block === "object"
				? (event.content_block as Record<string, unknown>)
				: null;
		const index = typeof event.index === "number" ? event.index : null;

		if (contentBlock?.type === "thinking" && index !== null && toolUseStateByIndex) {
			toolUseStateByIndex.set(index, {
				id: null,
				inputJson: "",
				name: "__thinking__",
			});
			return [];
		}

		if (
			contentBlock?.type === "tool_use" &&
			typeof contentBlock.name === "string" &&
			index !== null &&
			toolUseStateByIndex
		) {
			const initialInput = getToolInputRecord(contentBlock.input);
			const state: ClaudeStreamToolUseState = {
				id: typeof contentBlock.id === "string" ? contentBlock.id : null,
				inputJson: Object.keys(initialInput).length === 0 ? "" : JSON.stringify(initialInput),
				name: contentBlock.name,
			};
			toolUseStateByIndex.set(index, state);

			return [
				{
					type: "host-event",
					kind: "tool-call",
					summary: contentBlock.name,
					data: {
						toolName: contentBlock.name,
						toolUseId: state.id,
						input: initialInput,
						partial: true,
					},
					rawProviderEvent: rawEvent,
				},
			];
		}

		return [];
	}

	if (event.type === "content_block_stop") {
		if (typeof event.index === "number") {
			const stoppedState = toolUseStateByIndex?.get(event.index);

			if (stoppedState?.name === "__thinking__" && stoppedState.inputJson.length > 0) {
				toolUseStateByIndex?.delete(event.index);
				return [
					{
						type: "host-event",
						kind: "text",
						summary: "Thinking",
						data: {
							role: "thinking",
							text: stoppedState.inputJson,
						},
						rawProviderEvent: rawEvent,
					},
				];
			}

			toolUseStateByIndex?.delete(event.index);
		}

		return [];
	}

	if (event.type !== "content_block_delta") {
		return [];
	}

	const delta =
		event.delta && typeof event.delta === "object"
			? (event.delta as Record<string, unknown>)
			: null;

	if (!delta) {
		return [];
	}

	if (
		delta.type === "thinking_delta" &&
		typeof delta.thinking === "string" &&
		delta.thinking.length > 0
	) {
		const thinkingState =
			typeof event.index === "number" ? toolUseStateByIndex?.get(event.index) : null;

		if (thinkingState?.name === "__thinking__") {
			thinkingState.inputJson += delta.thinking;
		}

		return [];
	}

	if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text.length > 0) {
		return [
			{
				type: "host-event",
				kind: "text",
				summary: "Assistant message",
				data: {
					role: "assistant",
					text: delta.text,
					partial: true,
				},
				rawProviderEvent: rawEvent,
			},
		];
	}

	if (
		delta.type === "input_json_delta" &&
		typeof delta.partial_json === "string" &&
		typeof event.index === "number" &&
		toolUseStateByIndex?.has(event.index)
	) {
		const state = toolUseStateByIndex.get(event.index);

		if (!state) {
			return [];
		}

		state.inputJson += delta.partial_json;

		return [
			{
				type: "host-event",
				kind: "tool-call",
				summary: state.name,
				data: {
					toolName: state.name,
					toolUseId: state.id,
					input: tryParsePartialJsonRecord(state.inputJson),
					inputJson: state.inputJson,
					partial: true,
				},
				rawProviderEvent: rawEvent,
			},
		];
	}

	return [];
}

export function normalizeClaudeEvent(rawEvent: Record<string, unknown>): ProviderAdapterEvent[] {
	const type = typeof rawEvent.type === "string" ? rawEvent.type : "unknown";
	const usage = parseClaudeUsage(rawEvent);
	const limit = parseClaudeLimit(rawEvent);

	if (type === "system" && rawEvent.subtype === "init") {
		const providerSessionRef = typeof rawEvent.session_id === "string" ? rawEvent.session_id : null;

		return providerSessionRef ? [{ type: "provider-session", providerSessionRef }] : [];
	}

	if (type === "assistant") {
		const events: ProviderAdapterEvent[] = [];

		for (const item of getMessageContent(rawEvent)) {
			if (!item || typeof item !== "object") {
				continue;
			}

			const contentItem = item as Record<string, unknown>;

			if (contentItem.type === "thinking" && typeof contentItem.thinking === "string") {
				events.push({
					type: "host-event",
					kind: "text",
					summary: "Thinking",
					data: {
						role: "thinking",
						text: contentItem.thinking,
					},
					rawProviderEvent: rawEvent,
				});
			}

			if (contentItem.type === "text" && typeof contentItem.text === "string") {
				events.push({
					type: "host-event",
					kind: "text",
					summary: "Assistant message",
					data: {
						role: "assistant",
						text: contentItem.text,
					},
					rawProviderEvent: rawEvent,
				});
			}

			if (contentItem.type === "tool_use" && typeof contentItem.name === "string") {
				events.push({
					type: "host-event",
					kind: "tool-call",
					summary: contentItem.name,
					data: {
						toolName: contentItem.name,
						toolUseId: typeof contentItem.id === "string" ? contentItem.id : null,
						input: getToolInputRecord(contentItem.input),
					},
					rawProviderEvent: rawEvent,
				});
			}
		}

		if (usage) {
			const lastEvent = events.at(-1);

			if (lastEvent?.type === "host-event") {
				lastEvent.data = {
					...lastEvent.data,
					usage,
				};
			}
		}

		return events;
	}

	if (type === "user") {
		const events: ProviderAdapterEvent[] = [];

		for (const item of getMessageContent(rawEvent)) {
			if (!item || typeof item !== "object") {
				continue;
			}

			const contentItem = item as Record<string, unknown>;

			if (contentItem.type === "tool_result") {
				const content =
					typeof contentItem.content === "string"
						? contentItem.content
						: JSON.stringify(contentItem);

				events.push({
					type: "host-event",
					kind: "tool-result",
					summary: "Tool result",
					data: {
						toolUseId: typeof contentItem.tool_use_id === "string" ? contentItem.tool_use_id : null,
						content,
						isError: contentItem.is_error === true,
						blockReason: contentItem.is_error === true ? classifyClaudeBlockReason(content) : null,
					},
					rawProviderEvent: rawEvent,
				});
			}
		}

		return events;
	}

	if (type === "result") {
		const events = normalizeClaudeResult(rawEvent);

		if (usage && events[0]?.type === "host-event") {
			events[0].data = {
				...events[0].data,
				usage,
			};
		}

		return events;
	}

	if (type === "rate_limit_event" && limit) {
		return [
			{
				type: "host-event",
				kind: "system",
				summary: "Rate limit update",
				data: {
					limit,
				},
				rawProviderEvent: rawEvent,
			},
		];
	}

	if (type === "progress" || type === "system") {
		const retryStatus = parseClaudeRetryStatus(rawEvent);

		if (retryStatus) {
			return [
				{
					type: "session-status",
					status: "retrying",
					detail: retryStatus,
				},
			];
		}
	}

	return [
		{
			type: "host-event",
			kind: "system",
			summary: type,
			data: rawEvent,
			rawProviderEvent: rawEvent,
		},
	];
}

async function* streamClaudeProcess(
	runInput: ProviderAdapterRunInput,
): AsyncGenerator<ProviderAdapterEvent> {
	const subprocess = Bun.spawn(createClaudeCommand(runInput), {
		cwd: runInput.session.cwd,
		stdout: "pipe",
		stderr: "pipe",
		signal: runInput.signal,
		env: Bun.env,
	});
	const stdoutReader = subprocess.stdout.getReader();
	const stderrReader = subprocess.stderr.getReader();

	let buffer = "";
	let sawAssistantTextDelta = false;
	let sawThinkingBlock = false;
	const partialToolUseIds = new Set<string>();
	const toolUseStateByIndex = new Map<number, ClaudeStreamToolUseState>();

	try {
		while (true) {
			const { done, value } = await stdoutReader.read();

			if (done) {
				break;
			}

			buffer += decoder.decode(value);
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";

			for (const line of lines) {
				const trimmed = line.trim();

				if (trimmed.length === 0) {
					continue;
				}

				const rawEvent = JSON.parse(trimmed) as Record<string, unknown>;

				if (rawEvent.type === "stream_event") {
					const partialEvents = normalizeClaudeStreamEvent(rawEvent, toolUseStateByIndex);

					if (partialEvents.length > 0) {
						for (const event of partialEvents) {
							if (event.type !== "host-event") {
								continue;
							}

							if (event.kind === "text" && event.data.role === "thinking") {
								sawThinkingBlock = true;
							} else if (event.kind === "text") {
								sawAssistantTextDelta = true;
							}

							if (event.kind === "tool-call" && typeof event.data.toolUseId === "string") {
								partialToolUseIds.add(event.data.toolUseId);
							}
						}

						for (const event of partialEvents) {
							yield event;
						}
					}

					continue;
				}

				const normalizedEvents = normalizeClaudeEvent(rawEvent).filter((event) => {
					if (
						sawAssistantTextDelta &&
						rawEvent.type === "assistant" &&
						event.type === "host-event" &&
						event.kind === "text" &&
						event.data.role === "assistant"
					) {
						return false;
					}

					if (
						sawThinkingBlock &&
						rawEvent.type === "assistant" &&
						event.type === "host-event" &&
						event.kind === "text" &&
						event.data.role === "thinking"
					) {
						return false;
					}

					if (
						rawEvent.type === "assistant" &&
						event.type === "host-event" &&
						event.kind === "tool-call" &&
						typeof event.data.toolUseId === "string" &&
						partialToolUseIds.has(event.data.toolUseId)
					) {
						return false;
					}

					return true;
				});

				if (rawEvent.type === "assistant") {
					sawAssistantTextDelta = false;
				}

				for (const event of normalizedEvents) {
					yield event;
				}
			}
		}

		if (buffer.trim().length > 0) {
			const rawEvent = JSON.parse(buffer.trim()) as Record<string, unknown>;

			if (rawEvent.type === "stream_event") {
				const partialEvents = normalizeClaudeStreamEvent(rawEvent, toolUseStateByIndex);

				if (partialEvents.length > 0) {
					for (const event of partialEvents) {
						if (event.type !== "host-event") {
							continue;
						}

						if (event.kind === "text" && event.data.role === "thinking") {
							sawThinkingBlock = true;
						} else if (event.kind === "text") {
							sawAssistantTextDelta = true;
						}

						if (event.kind === "tool-call" && typeof event.data.toolUseId === "string") {
							partialToolUseIds.add(event.data.toolUseId);
						}
					}
				}

				for (const event of partialEvents) {
					yield event;
				}
			} else {
				const normalizedEvents = normalizeClaudeEvent(rawEvent).filter((event) => {
					if (
						sawAssistantTextDelta &&
						rawEvent.type === "assistant" &&
						event.type === "host-event" &&
						event.kind === "text" &&
						event.data.role === "assistant"
					) {
						return false;
					}

					if (
						sawThinkingBlock &&
						rawEvent.type === "assistant" &&
						event.type === "host-event" &&
						event.kind === "text" &&
						event.data.role === "thinking"
					) {
						return false;
					}

					if (
						rawEvent.type === "assistant" &&
						event.type === "host-event" &&
						event.kind === "tool-call" &&
						typeof event.data.toolUseId === "string" &&
						partialToolUseIds.has(event.data.toolUseId)
					) {
						return false;
					}

					return true;
				});

				if (rawEvent.type === "assistant") {
					sawAssistantTextDelta = false;
				}

				for (const event of normalizedEvents) {
					yield event;
				}
			}
		}

		const stderrChunks: Uint8Array[] = [];

		while (true) {
			const { done, value } = await stderrReader.read();

			if (done) {
				break;
			}

			stderrChunks.push(value);
		}

		const exitCode = await subprocess.exited;

		if (exitCode !== 0) {
			yield {
				type: "host-event",
				kind: "error",
				summary: "Claude CLI error",
				data: {
					exitCode,
					stderr: Buffer.concat(stderrChunks).toString("utf8").trim(),
				},
				rawProviderEvent: null,
			};
		}
	} finally {
		stdoutReader.releaseLock();
		stderrReader.releaseLock();
	}
}

export async function parseClaudeHistoricalSession(
	path: string,
): Promise<HistoricalSession | null> {
	if (path.includes("/subagents/")) {
		return null;
	}

	const headLines = await readHeadJsonl(path);
	let cwd = "";
	let title = basename(path, ".jsonl");
	let preview = "";
	let providerSessionRef = basename(path, ".jsonl");
	let createTime = Number(Bun.file(path).lastModified || Date.now());

	for (const line of headLines) {
		if (typeof line.sessionId === "string") {
			providerSessionRef = line.sessionId;
		}

		if (typeof line.cwd === "string" && line.cwd.length > 0) {
			cwd = line.cwd;
		}

		if (line.message && typeof line.message === "object") {
			const message = line.message as Record<string, unknown>;

			if (typeof message.content === "string" && preview.length === 0) {
				preview = message.content.slice(0, 200);
				title = message.content.slice(0, 72);
			}
		}

		if (typeof line.timestamp === "string") {
			const parsed = Date.parse(line.timestamp);

			if (!Number.isNaN(parsed)) {
				createTime = parsed;
				break;
			}
		}
	}

	if (cwd.length === 0) {
		return null;
	}

	const stats = await Bun.file(path).stat();

	return {
		provider: "claude",
		providerSessionRef,
		title,
		cwd,
		sourcePath: path,
		createTime,
		updateTime: stats.mtimeMs,
		preview,
	};
}

export class ClaudeProviderAdapter implements ProviderAdapter {
	readonly id = "claude" as const;
	readonly label = "Claude Code";

	capabilities() {
		return claudeCapabilities;
	}

	summary(): ProviderSummary {
		const isAvailable = Bun.which(getClaudeBin()) !== null;

		return {
			id: this.id,
			label: this.label,
			status: isAvailable ? "ready" : "partial",
			statusDetail: isAvailable
				? null
				: "Claude CLI not found in PATH. Install it or set SHELLEPORT_CLAUDE_BIN.",
			capabilities: this.capabilities(),
		};
	}

	sendInput(runInput: ProviderAdapterRunInput): AsyncGenerator<ProviderAdapterEvent> {
		return streamClaudeProcess(runInput);
	}

	resumeSession(
		session: HostSession,
		runInput: ProviderAdapterRunInput,
	): AsyncGenerator<ProviderAdapterEvent> {
		return streamClaudeProcess({ ...runInput, session });
	}

	async listHistoricalSessions() {
		const rootPath = `${Bun.env.HOME ?? ""}/.claude/projects`;
		const fileList = await listJsonlFiles(rootPath);
		const sessions = await Promise.all(fileList.map(parseClaudeHistoricalSession));
		return sessions
			.filter((session) => session !== null)
			.sort((left, right) => right.updateTime - left.updateTime);
	}
}
