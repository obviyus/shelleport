import { basename } from "node:path";
import { getClaudeBin } from "~/server/config.server";
import type {
	HistoricalSession,
	HostSession,
	PendingRequest,
	ProviderCapabilities,
	ProviderSummary,
	RequestResponsePayload,
	SessionLimit,
	SessionControlPayload,
	SessionUsage,
} from "~/shared/shelleport";
import type {
	ProviderAdapter,
	ProviderAdapterEvent,
	ProviderAdapterRunInput,
} from "~/server/providers/provider.server";
import { listJsonlFiles, readHeadJsonl } from "~/server/providers/jsonl.server";
import { sessionStore } from "~/server/store.server";

const decoder = new TextDecoder();

const claudeCapabilities: ProviderCapabilities = {
	canCreate: true,
	canResumeHistorical: true,
	canInterrupt: true,
	canTerminate: true,
	hasStructuredEvents: true,
	supportsApprovals: true,
	supportsQuestions: true,
	supportsAttachments: true,
	supportsFork: false,
	supportsWorktree: true,
	liveResume: "managed-only",
};

type ClaudeRetryStatus = {
	message: string;
	attempt: number | null;
	nextRetryTime: number | null;
};

type ClaudeBridgePendingRequest = {
	requestId: string;
	kind: PendingRequest["kind"];
	blockReason: PendingRequest["blockReason"];
	prompt: string;
	data: Record<string, unknown>;
	input: Record<string, unknown> | null;
};

type ClaudeTurnStream = {
	push(event: ProviderAdapterEvent): void;
	finish(): void;
	fail(error: unknown): void;
	iterate(): AsyncGenerator<ProviderAdapterEvent>;
};

type ClaudeLiveSession = {
	sessionId: string;
	cwd: string;
	model: HostSession["model"];
	effort: HostSession["effort"];
	systemPrompt: HostSession["systemPrompt"];
	permissionMode: HostSession["permissionMode"];
	allowedTools: string[];
	subprocess: Bun.Subprocess<"pipe", "pipe", "pipe">;
	mergeState: ClaudeStreamMergeState;
	currentTurn: ClaudeTurnStream | null;
	pendingRequests: Map<string, ClaudeBridgePendingRequest>;
	idleTimer: ReturnType<typeof setTimeout> | null;
	stopping: boolean;
	interruptRequested: boolean;
	terminateRequested: boolean;
	write(message: Record<string, unknown>): void;
	close(reason?: "idle" | "terminate" | "delete" | "restart"): void;
};

const CLAUDE_IDLE_TIMEOUT_MS = 10 * 60 * 1_000;

const activeClaudeSessions = new Map<string, ClaudeLiveSession>();

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

function createClaudeCommand(session: HostSession) {
	const command = [
		getClaudeBin(),
		"--verbose",
		"--include-partial-messages",
		"--print",
		"--input-format",
		"stream-json",
		"--output-format",
		"stream-json",
		"--replay-user-messages",
		"--permission-prompt-tool",
		"stdio",
		"--permission-mode",
		session.permissionMode,
	];

	if (session.model) {
		command.push("--model", session.model);
	}

	if (session.effort) {
		command.push("--effort", session.effort);
	}

	if (session.systemPrompt) {
		command.push("--append-system-prompt", session.systemPrompt);
	}

	for (const toolRule of session.allowedTools) {
		command.push("--allowedTools", toolRule);
	}

	if (session.providerSessionRef) {
		command.push("-r", session.providerSessionRef);
	}

	return command;
}

function createClaudeTurnStream(): ClaudeTurnStream {
	const queue: ProviderAdapterEvent[] = [];
	const waiters: Array<{
		resolve(result: IteratorResult<ProviderAdapterEvent>): void;
		reject(error: unknown): void;
	}> = [];
	let done = false;
	let failure: unknown = null;

	return {
		push(event) {
			if (done || failure) {
				return;
			}

			const waiter = waiters.shift();

			if (waiter) {
				waiter.resolve({ value: event, done: false });
				return;
			}

			queue.push(event);
		},
		finish() {
			if (done || failure) {
				return;
			}

			done = true;

			for (const waiter of waiters.splice(0)) {
				waiter.resolve({ value: undefined, done: true });
			}
		},
		fail(error) {
			if (done || failure) {
				return;
			}

			failure = error;

			for (const waiter of waiters.splice(0)) {
				waiter.reject(error);
			}
		},
		async *iterate() {
			for (;;) {
				if (queue.length > 0) {
					yield queue.shift()!;
					continue;
				}

				if (failure) {
					throw failure;
				}

				if (done) {
					return;
				}

				const result = await new Promise<IteratorResult<ProviderAdapterEvent>>((resolve, reject) =>
					waiters.push({ resolve, reject }),
				);

				if (result.done) {
					return;
				}

				yield result.value;
			}
		},
	};
}

function isClaudeInterruptedResult(
	liveSession: ClaudeLiveSession,
	rawEvent: Record<string, unknown>,
) {
	return (
		liveSession.interruptRequested &&
		rawEvent.type === "result" &&
		rawEvent.is_error === true &&
		rawEvent.subtype === "error_during_execution"
	);
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

function readClaudeControlRequestSubtype(request: Record<string, unknown> | null) {
	return typeof request?.subtype === "string" ? request.subtype : null;
}

function createClaudeQuestionPrompt(request: Record<string, unknown>, subtype: string) {
	const promptFields = [
		request.prompt,
		request.message,
		request.question,
		request.description,
	].filter((value): value is string => typeof value === "string" && value.trim().length > 0);

	return promptFields[0] ?? `Claude request: ${subtype}`;
}

function createClaudePendingRequest(
	requestId: string,
	request: Record<string, unknown>,
): ClaudeBridgePendingRequest | null {
	const subtype = readClaudeControlRequestSubtype(request);

	if (!subtype || subtype === "interrupt") {
		return null;
	}

	if (subtype === "can_use_tool") {
		const toolName = typeof request.tool_name === "string" ? request.tool_name : null;
		const toolUseId = typeof request.tool_use_id === "string" ? request.tool_use_id : null;
		const input =
			request.input && typeof request.input === "object"
				? (request.input as Record<string, unknown>)
				: {};

		if (!toolName || !toolUseId) {
			return null;
		}

		return {
			requestId,
			kind: "approval",
			blockReason: "permission",
			prompt: createClaudeApprovalPrompt(toolName, input),
			data: {
				requestId,
				subtype,
				toolUseId,
				toolName,
				toolInput: input,
				toolRule:
					toolName === "Bash" && typeof input.command === "string"
						? createClaudeBashToolRule(input.command)
						: toolName,
				request,
			},
			input,
		};
	}

	return {
		requestId,
		kind: "question",
		blockReason: null,
		prompt: createClaudeQuestionPrompt(request, subtype),
		data: {
			requestId,
			subtype,
			request,
		},
		input:
			request.input && typeof request.input === "object"
				? (request.input as Record<string, unknown>)
				: null,
	};
}

function createClaudeUserInputMessage(content: string) {
	return {
		type: "user",
		session_id: "",
		parent_tool_use_id: null,
		message: {
			role: "user",
			content,
		},
	};
}

function writeClaudeBridgeMessage(
	sessionId: string,
	subprocess: Bun.Subprocess<"pipe", "pipe", "pipe">,
	message: Record<string, unknown>,
) {
	sessionStore.appendProtocolFrame(sessionId, {
		provider: "claude",
		direction: "out",
		frame: message,
	});
	void subprocess.stdin.write(`${JSON.stringify(message)}\n`);
	void subprocess.stdin.flush();
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

type ClaudeStreamContentState =
	| {
			type: "thinking";
			text: string;
	  }
	| {
			type: "tool-use";
			id: string | null;
			inputJson: string;
			name: string;
	  };

type ClaudeStreamMergeState = {
	contentStateByIndex: Map<number, ClaudeStreamContentState>;
	partialToolUseIds: Set<string>;
	sawAssistantTextDelta: boolean;
	sawThinkingBlock: boolean;
	detectedModel: string | null;
};

export function normalizeClaudeStreamEvent(
	rawEvent: Record<string, unknown>,
	contentStateByIndex?: Map<number, ClaudeStreamContentState>,
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

		if (contentBlock?.type === "thinking" && index !== null && contentStateByIndex) {
			contentStateByIndex.set(index, {
				type: "thinking",
				text: "",
			});
			return [];
		}

		if (
			contentBlock?.type === "tool_use" &&
			typeof contentBlock.name === "string" &&
			index !== null &&
			contentStateByIndex
		) {
			const initialInput = getToolInputRecord(contentBlock.input);
			const state: ClaudeStreamContentState = {
				type: "tool-use",
				id: typeof contentBlock.id === "string" ? contentBlock.id : null,
				inputJson: Object.keys(initialInput).length === 0 ? "" : JSON.stringify(initialInput),
				name: contentBlock.name,
			};
			contentStateByIndex.set(index, state);

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
			const stoppedState = contentStateByIndex?.get(event.index);

			if (stoppedState?.type === "thinking" && stoppedState.text.length > 0) {
				contentStateByIndex?.delete(event.index);
				return [
					{
						type: "host-event",
						kind: "text",
						summary: "Thinking",
						data: {
							role: "thinking",
							text: stoppedState.text,
						},
						rawProviderEvent: rawEvent,
					},
				];
			}

			contentStateByIndex?.delete(event.index);
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
		const contentState =
			typeof event.index === "number" ? contentStateByIndex?.get(event.index) : null;

		if (contentState?.type === "thinking") {
			contentState.text += delta.thinking;
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
		contentStateByIndex?.has(event.index)
	) {
		const state = contentStateByIndex.get(event.index);

		if (!state || state.type !== "tool-use") {
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

export function updateClaudeStreamMergeState(
	state: ClaudeStreamMergeState,
	events: ProviderAdapterEvent[],
) {
	for (const event of events) {
		if (event.type !== "host-event") {
			continue;
		}

		if (event.kind === "text" && event.data.role === "thinking") {
			state.sawThinkingBlock = true;
			continue;
		}

		if (event.kind === "text") {
			state.sawAssistantTextDelta = true;
			continue;
		}

		if (event.kind === "tool-call" && typeof event.data.toolUseId === "string") {
			state.partialToolUseIds.add(event.data.toolUseId);
		}
	}
}

export function filterClaudeStreamDuplicates(
	rawEvent: Record<string, unknown>,
	events: ProviderAdapterEvent[],
	state: Pick<
		ClaudeStreamMergeState,
		"sawAssistantTextDelta" | "sawThinkingBlock" | "partialToolUseIds"
	>,
) {
	if (rawEvent.type !== "assistant") {
		return events;
	}

	return events.filter((event) => {
		if (
			state.sawAssistantTextDelta &&
			event.type === "host-event" &&
			event.kind === "text" &&
			event.data.role === "assistant"
		) {
			return false;
		}

		if (
			state.sawThinkingBlock &&
			event.type === "host-event" &&
			event.kind === "text" &&
			event.data.role === "thinking"
		) {
			return false;
		}

		if (
			event.type === "host-event" &&
			event.kind === "tool-call" &&
			typeof event.data.toolUseId === "string" &&
			state.partialToolUseIds.has(event.data.toolUseId)
		) {
			return false;
		}

		return true;
	});
}

function resetClaudeStreamMergeStateAfterAssistant(
	rawEvent: Record<string, unknown>,
	state: ClaudeStreamMergeState,
) {
	if (rawEvent.type !== "assistant") {
		return;
	}

	state.sawAssistantTextDelta = false;
	state.sawThinkingBlock = false;
	state.partialToolUseIds.clear();
}

async function* streamClaudeProcess(
	runInput: ProviderAdapterRunInput,
): AsyncGenerator<ProviderAdapterEvent> {
	let liveSession: ClaudeLiveSession | null = activeClaudeSessions.get(runInput.session.id) ?? null;

	if (liveSession && !matchesClaudeLiveSession(liveSession, runInput.session)) {
		liveSession.close("restart");
		liveSession = null;
	}

	if (liveSession && !(await canReuseClaudeLiveSession(liveSession))) {
		liveSession.close("restart");
		liveSession = null;
	}

	const turn = createClaudeTurnStream();

	if (!liveSession) {
		liveSession = createClaudeLiveSession(runInput.session, turn);
		activeClaudeSessions.set(runInput.session.id, liveSession);
	} else {
		if (liveSession.idleTimer) {
			clearTimeout(liveSession.idleTimer);
			liveSession.idleTimer = null;
		}

		if (liveSession.currentTurn) {
			throw new Error("Claude session is already handling a turn");
		}

		liveSession.currentTurn = turn;
	}

	liveSession.write(
		createClaudeUserInputMessage(formatClaudePrompt(runInput.prompt, runInput.attachments)),
	);

	yield* turn.iterate();
}

async function canReuseClaudeLiveSession(liveSession: ClaudeLiveSession) {
	if (liveSession.stopping || liveSession.currentTurn !== null) {
		return false;
	}

	const exited = await Promise.race([
		liveSession.subprocess.exited.then(() => true),
		Bun.sleep(10).then(() => false),
	]);

	return !exited;
}

function matchesClaudeLiveSession(liveSession: ClaudeLiveSession, session: HostSession) {
	return (
		liveSession.cwd === session.cwd &&
		liveSession.model === session.model &&
		liveSession.effort === session.effort &&
		liveSession.systemPrompt === session.systemPrompt &&
		liveSession.permissionMode === session.permissionMode &&
		liveSession.allowedTools.length === session.allowedTools.length &&
		liveSession.allowedTools.every((toolRule, index) => toolRule === session.allowedTools[index])
	);
}

function scheduleClaudeLiveSessionIdleClose(liveSession: ClaudeLiveSession) {
	if (liveSession.idleTimer) {
		clearTimeout(liveSession.idleTimer);
	}

	if (liveSession.currentTurn || liveSession.pendingRequests.size > 0 || liveSession.stopping) {
		liveSession.idleTimer = null;
		return;
	}

	liveSession.idleTimer = setTimeout(() => {
		if (liveSession.currentTurn || liveSession.pendingRequests.size > 0) {
			return;
		}

		liveSession.close("idle");
	}, CLAUDE_IDLE_TIMEOUT_MS);
}

function createClaudeLiveSession(
	session: HostSession,
	initialTurn: ClaudeTurnStream,
): ClaudeLiveSession {
	const abortController = new AbortController();
	const subprocess = Bun.spawn(createClaudeCommand(session), {
		cwd: session.cwd,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		signal: abortController.signal,
		env: Bun.env,
	});
	const liveSession: ClaudeLiveSession = {
		sessionId: session.id,
		cwd: session.cwd,
		model: session.model,
		effort: session.effort,
		systemPrompt: session.systemPrompt,
		permissionMode: session.permissionMode,
		allowedTools: [...session.allowedTools],
		subprocess,
		mergeState: {
			contentStateByIndex: new Map<number, ClaudeStreamContentState>(),
			partialToolUseIds: new Set<string>(),
			sawAssistantTextDelta: false,
			sawThinkingBlock: false,
			detectedModel: session.model,
		},
		currentTurn: initialTurn,
		pendingRequests: new Map(),
		idleTimer: null,
		stopping: false,
		interruptRequested: false,
		terminateRequested: false,
		write(message) {
			writeClaudeBridgeMessage(session.id, subprocess, message);
		},
		close(reason = "idle") {
			if (liveSession.stopping) {
				return;
			}

			liveSession.stopping = true;
			liveSession.terminateRequested = reason === "terminate";

			if (liveSession.idleTimer) {
				clearTimeout(liveSession.idleTimer);
				liveSession.idleTimer = null;
			}

			if (activeClaudeSessions.get(session.id) === liveSession) {
				activeClaudeSessions.delete(session.id);
			}

			try {
				void subprocess.stdin.end();
			} catch {}
		},
	};

	void runClaudeLiveSession(liveSession);

	return liveSession;
}

function pushClaudeTurnEvent(liveSession: ClaudeLiveSession, event: ProviderAdapterEvent) {
	liveSession.currentTurn?.push(event);
}

function finishClaudeTurn(liveSession: ClaudeLiveSession) {
	liveSession.currentTurn?.finish();
	liveSession.currentTurn = null;
	scheduleClaudeLiveSessionIdleClose(liveSession);
}

function failClaudeTurn(liveSession: ClaudeLiveSession, error: unknown) {
	liveSession.currentTurn?.fail(error);
	liveSession.currentTurn = null;
}

async function runClaudeLiveSession(liveSession: ClaudeLiveSession) {
	const stdoutReader = liveSession.subprocess.stdout.getReader();
	const stderrReader = liveSession.subprocess.stderr.getReader();
	const stderrChunks: Uint8Array[] = [];
	let buffer = "";

	function detectModel(rawEvent: Record<string, unknown>) {
		if (liveSession.mergeState.detectedModel) {
			return;
		}

		const message =
			rawEvent.message && typeof rawEvent.message === "object"
				? (rawEvent.message as Record<string, unknown>)
				: null;

		if (typeof message?.model === "string") {
			liveSession.mergeState.detectedModel = message.model;
			return;
		}

		const usage = parseClaudeUsage(rawEvent);

		if (usage?.model) {
			liveSession.mergeState.detectedModel = usage.model;
		}
	}

	function stampModel(event: ProviderAdapterEvent): ProviderAdapterEvent {
		if (event.type !== "host-event" || !liveSession.mergeState.detectedModel) {
			return event;
		}

		return {
			...event,
			data: { ...event.data, model: liveSession.mergeState.detectedModel },
		};
	}

	function handleRawEvent(rawEvent: Record<string, unknown>) {
		sessionStore.appendProtocolFrame(liveSession.sessionId, {
			provider: "claude",
			direction: "in",
			frame: rawEvent,
		});
		detectModel(rawEvent);

		if (rawEvent.type === "control_request") {
			const request =
				rawEvent.request && typeof rawEvent.request === "object"
					? (rawEvent.request as Record<string, unknown>)
					: null;
			const requestId = typeof rawEvent.request_id === "string" ? rawEvent.request_id : null;

			if (requestId && request) {
				const pendingRequest = createClaudePendingRequest(requestId, request);

				if (pendingRequest) {
					liveSession.pendingRequests.set(requestId, pendingRequest);
					pushClaudeTurnEvent(liveSession, {
						type: "pending-request",
						kind: pendingRequest.kind,
						blockReason: pendingRequest.blockReason,
						prompt: pendingRequest.prompt,
						data: pendingRequest.data,
					});
				}
			}

			return;
		}

		if (rawEvent.type === "control_cancel_request") {
			const requestId = typeof rawEvent.request_id === "string" ? rawEvent.request_id : null;

			if (requestId) {
				liveSession.pendingRequests.delete(requestId);
			}

			return;
		}

		if (rawEvent.type === "control_response") {
			return;
		}

		if (isClaudeInterruptedResult(liveSession, rawEvent)) {
			liveSession.interruptRequested = false;
			pushClaudeTurnEvent(liveSession, {
				type: "host-event",
				kind: "system",
				summary: "Session interrupted",
				data: {},
				rawProviderEvent: rawEvent,
			});
			pushClaudeTurnEvent(liveSession, {
				type: "session-status",
				status: "interrupted",
				detail: {},
			});
			finishClaudeTurn(liveSession);
			return;
		}

		if (rawEvent.type === "stream_event") {
			const partialEvents = normalizeClaudeStreamEvent(
				rawEvent,
				liveSession.mergeState.contentStateByIndex,
			);
			updateClaudeStreamMergeState(liveSession.mergeState, partialEvents);

			for (const event of partialEvents) {
				pushClaudeTurnEvent(liveSession, stampModel(event));
			}

			return;
		}

		const normalizedEvents = filterClaudeStreamDuplicates(
			rawEvent,
			normalizeClaudeEvent(rawEvent),
			liveSession.mergeState,
		);
		resetClaudeStreamMergeStateAfterAssistant(rawEvent, liveSession.mergeState);

		for (const event of normalizedEvents) {
			pushClaudeTurnEvent(liveSession, stampModel(event));
		}

		if (rawEvent.type === "result") {
			liveSession.interruptRequested = false;
			finishClaudeTurn(liveSession);
		}
	}

	const stderrPromise = (async () => {
		for (;;) {
			const { done, value } = await stderrReader.read();

			if (done) {
				return;
			}

			stderrChunks.push(value);
		}
	})();

	try {
		for (;;) {
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

				handleRawEvent(JSON.parse(trimmed) as Record<string, unknown>);
			}
		}

		if (buffer.trim().length > 0) {
			handleRawEvent(JSON.parse(buffer.trim()) as Record<string, unknown>);
		}
	} catch (error) {
		failClaudeTurn(liveSession, error);
	} finally {
		await stderrPromise;
		stdoutReader.releaseLock();
		stderrReader.releaseLock();
	}

	const exitCode = await liveSession.subprocess.exited;

	if (liveSession.idleTimer) {
		clearTimeout(liveSession.idleTimer);
		liveSession.idleTimer = null;
	}

	if (activeClaudeSessions.get(liveSession.sessionId) === liveSession) {
		activeClaudeSessions.delete(liveSession.sessionId);
	}

	if (exitCode !== 0 && !liveSession.stopping) {
		pushClaudeTurnEvent(liveSession, {
			type: "host-event",
			kind: "error",
			summary: "Claude CLI error",
			data: {
				exitCode,
				stderr: Buffer.concat(stderrChunks).toString("utf8").trim(),
			},
			rawProviderEvent: null,
		});
	}

	if (liveSession.currentTurn) {
		if (liveSession.terminateRequested) {
			failClaudeTurn(liveSession, new Error("Claude session terminated"));
		} else {
			finishClaudeTurn(liveSession);
		}
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
			models: [
				{ id: "sonnet", label: "Sonnet" },
				{ id: "sonnet[1m]", label: "Sonnet 1M" },
				{ id: "opus", label: "Opus" },
				{ id: "opus[1m]", label: "Opus 1M" },
				{ id: "haiku", label: "Haiku" },
			],
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

	canHandleRequestResponse(session: HostSession, request: PendingRequest) {
		return activeClaudeSessions.has(session.id) && typeof request.data.requestId === "string";
	}

	async respondToRequest(
		session: HostSession,
		request: PendingRequest,
		input: RequestResponsePayload,
	) {
		const handle = activeClaudeSessions.get(session.id);
		const requestId = typeof request.data.requestId === "string" ? request.data.requestId : null;

		if (!handle || !requestId) {
			throw new Error("Claude bridge request is no longer active");
		}

		const pendingRequest = handle.pendingRequests.get(requestId);

		if (!pendingRequest) {
			throw new Error("Claude bridge request is no longer pending");
		}

		handle.pendingRequests.delete(requestId);
		handle.write({
			type: "control_response",
			response: {
				subtype: "success",
				request_id: requestId,
				response:
					input.decision === "allow"
						? pendingRequest.input
							? {
									behavior: "allow",
									updatedInput: pendingRequest.input,
								}
							: {
									behavior: "allow",
								}
						: {
								behavior: "deny",
								message: "User denied permission",
							},
			},
		});
	}

	canHandleControl(session: HostSession) {
		return activeClaudeSessions.has(session.id);
	}

	async controlSession(session: HostSession, input: SessionControlPayload) {
		const handle = activeClaudeSessions.get(session.id);

		if (!handle) {
			return;
		}

		if (input.action === "terminate") {
			handle.close("terminate");
			return;
		}

		handle.interruptRequested = true;
		handle.write({
			type: "control_request",
			request_id: Bun.randomUUIDv7(),
			request: {
				subtype: "interrupt",
			},
		});
	}

	async deleteSession(session: HostSession) {
		activeClaudeSessions.get(session.id)?.close("delete");
	}
}
