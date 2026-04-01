import { basename } from "node:path";
import type {
	EffortLevel,
	HistoricalSession,
	HostSession,
	PendingRequest,
	ProviderCapabilities,
	ProviderModel,
	ProviderSummary,
	RequestResponsePayload,
	SessionAttachment,
	SessionControlPayload,
} from "~/shared/shelleport";
import { getCodexBin } from "~/server/config.server";
import type {
	ProviderAdapter,
	ProviderAdapterEvent,
	ProviderAdapterRunInput,
} from "~/server/providers/provider.server";
import { listJsonlFiles, readHeadJsonl } from "~/server/providers/jsonl.server";
import { sessionStore } from "~/server/store.server";

const decoder = new TextDecoder();
const CODEX_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const CODEX_MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

type CodexJsonObject = { [key: string]: unknown };
type CodexRpcId = number | string;

type CodexTurnStream = {
	push(event: ProviderAdapterEvent): void;
	finish(): void;
	fail(error: unknown): void;
	iterate(): AsyncGenerator<ProviderAdapterEvent>;
};

type CodexTurnState = {
	stream: CodexTurnStream;
	errorReported: boolean;
	agentTextByItemId: Map<string, string>;
	thinkingTextByItemId: Map<string, string>;
};

type CodexPendingRequest = {
	id: CodexRpcId;
	method: string;
	params: CodexJsonObject;
};

type CodexPendingResponse = {
	reject(error: unknown): void;
	resolve(result: CodexJsonObject): void;
};

type CodexLiveSession = {
	activeTurnId: string | null;
	abortController: AbortController;
	cwd: string;
	idleTimer: ReturnType<typeof setTimeout> | null;
	model: string | null;
	pendingRequests: Map<string, CodexPendingRequest>;
	pendingResponses: Map<string, CodexPendingResponse>;
	sessionId: string;
	stderrChunks: Uint8Array[];
	stopping: boolean;
	subprocess: Bun.Subprocess<"pipe", "pipe", "pipe">;
	threadId: string | null;
	turnState: CodexTurnState | null;
	write(frame: CodexJsonObject): void;
	close(reason?: "delete" | "idle" | "startup" | "terminate"): void;
};

const activeCodexSessions = new Map<string, CodexLiveSession>();
let codexModelCache:
	| {
			expiresAt: number;
			models: ProviderModel[];
	  }
	| null = null;
let codexModelRequest: Promise<ProviderModel[]> | null = null;

const codexCapabilities: ProviderCapabilities = {
	canCreate: true,
	canResumeHistorical: true,
	canInterrupt: true,
	canTerminate: false,
	hasStructuredEvents: true,
	supportsApprovals: true,
	supportsQuestions: false,
	supportsAttachments: true,
	supportsFork: true,
	supportsWorktree: true,
	liveResume: "provider-managed",
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function readNumber(value: unknown): number | null {
	return typeof value === "number" ? value : null;
}

function readArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function stringifyRpcId(value: unknown): string | null {
	return typeof value === "number" || typeof value === "string" ? String(value) : null;
}

function getCodexApprovalPolicy(permissionMode: HostSession["permissionMode"]) {
	return permissionMode === "bypassPermissions" ? "never" : "on-request";
}

function getCodexSandboxMode(permissionMode: HostSession["permissionMode"]) {
	return permissionMode === "bypassPermissions" ? "danger-full-access" : "workspace-write";
}

function getCodexEffort(effort: HostSession["effort"]) {
	if (effort === null) {
		return undefined;
	}

	return effort === "max" ? "xhigh" : effort;
}

function readCodexProviderEffort(value: unknown): EffortLevel | null {
	if (value === "low" || value === "medium" || value === "high") {
		return value;
	}

	if (value === "xhigh") {
		return "max";
	}

	return null;
}

function mapCodexModel(model: CodexJsonObject): ProviderModel | null {
	const id = readString(model.id);
	const label = readString(model.displayName);
	const supportedEfforts = readArray(model.supportedReasoningEfforts)
		.filter(isRecord)
		.map((option) => readCodexProviderEffort(option.reasoningEffort))
		.filter((effort): effort is EffortLevel => effort !== null);

	if (!id || !label) {
		return null;
	}

	return {
		defaultEffort: readCodexProviderEffort(model.defaultReasoningEffort),
		id,
		label,
		supportedEfforts,
	};
}

function createCodexTurnStream(): CodexTurnStream {
	const queue: ProviderAdapterEvent[] = [];
	const waiters: Array<{
		reject(error: unknown): void;
		resolve(result: IteratorResult<ProviderAdapterEvent>): void;
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

function buildCodexTextInput(prompt: string, attachments: SessionAttachment[]) {
	const workspaceFiles = attachments.filter((attachment) => !attachment.contentType.startsWith("image/"));

	if (workspaceFiles.length === 0) {
		return prompt.trim();
	}

	const attachmentList = workspaceFiles.map((attachment) => `- ${attachment.path}`).join("\n");

	if (prompt.trim().length > 0) {
		return `${prompt.trim()}\n\nAttached workspace files:\n${attachmentList}`;
	}

	return `Attached workspace files:\n${attachmentList}`;
}

function buildCodexUserInput(prompt: string, attachments: SessionAttachment[]) {
	const inputs: CodexJsonObject[] = [];
	const text = buildCodexTextInput(prompt, attachments);

	if (text.length > 0) {
		inputs.push({
			type: "text",
			text,
			text_elements: [],
		});
	}

	for (const attachment of attachments) {
		if (!attachment.contentType.startsWith("image/")) {
			continue;
		}

		inputs.push({
			type: "localImage",
			path: attachment.path,
		});
	}

	return inputs;
}

function createCodexUsage(totalUsage: Record<string, unknown>, model: string | null) {
	const inputTokens = readNumber(totalUsage.inputTokens);
	const outputTokens = readNumber(totalUsage.outputTokens);
	const cachedInputTokens = readNumber(totalUsage.cachedInputTokens);
	const reasoningOutputTokens = readNumber(totalUsage.reasoningOutputTokens);

	if (
		inputTokens === null ||
		outputTokens === null ||
		cachedInputTokens === null ||
		reasoningOutputTokens === null
	) {
		return null;
	}

	return {
		cacheCreationInputTokens: 0,
		cacheReadInputTokens: cachedInputTokens,
		costUsd: null,
		inputTokens,
		model,
		outputTokens: outputTokens + reasoningOutputTokens,
	};
}

function readCodexResponseThread(result: CodexJsonObject) {
	const thread = isRecord(result.thread) ? result.thread : null;
	const threadId = readString(thread?.id);

	if (!threadId) {
		throw new Error("Codex app-server response is missing a thread id");
	}

	return {
		model: readString(result.model),
		threadId,
	};
}

function readCodexTurnId(result: CodexJsonObject) {
	const turn = isRecord(result.turn) ? result.turn : null;
	const turnId = readString(turn?.id);

	if (!turnId) {
		throw new Error("Codex app-server response is missing a turn id");
	}

	return turnId;
}

function readCodexError(errorValue: unknown) {
	if (!isRecord(errorValue)) {
		return "Codex app-server request failed";
	}

	const message = readString(errorValue.message);

	if (message) {
		return message;
	}

	const nestedError = isRecord(errorValue.error) ? errorValue.error : null;
	return readString(nestedError?.message) ?? "Codex app-server request failed";
}

function createCodexThreadRequest(session: HostSession) {
	const baseParams = {
		approvalPolicy: getCodexApprovalPolicy(session.permissionMode),
		cwd: session.cwd,
		model: session.model ?? undefined,
		persistExtendedHistory: false,
		sandbox: getCodexSandboxMode(session.permissionMode),
	};

	if (session.providerSessionRef) {
		return {
			method: "thread/resume",
			params: {
				...baseParams,
				threadId: session.providerSessionRef,
			},
		} as const;
	}

	return {
		method: "thread/start",
		params: {
			...baseParams,
			experimentalRawEvents: false,
		},
	} as const;
}

function createCodexRequestDecision(decision: RequestResponsePayload["decision"]) {
	return decision === "allow" ? "accept" : "decline";
}

function mapCodexCommandCall(item: CodexJsonObject): ProviderAdapterEvent {
	const command = readString(item.command) ?? "";
	const cwd = readString(item.cwd) ?? "";

	return {
		type: "host-event",
		kind: "tool-call",
		summary: command || "Command execution",
		data: {
			input: { command, cwd },
			inputJson: JSON.stringify({ command, cwd }),
			toolName: "Bash",
			toolUseId: readString(item.id),
		},
		rawProviderEvent: item,
	};
}

function mapCodexCommandResult(item: CodexJsonObject): ProviderAdapterEvent {
	const status = readString(item.status);
	const output = readString(item.aggregatedOutput) ?? "";
	const exitCode = readNumber(item.exitCode);

	return {
		type: "host-event",
		kind: "tool-result",
		summary: status === "declined" ? "Command declined" : "Command finished",
		data: {
			exitCode,
			isError: status === "failed" || status === "declined",
			output,
			toolUseId: readString(item.id),
		},
		rawProviderEvent: item,
	};
}

function mapCodexFileChangeCall(item: CodexJsonObject): ProviderAdapterEvent {
	const changes = readArray(item.changes).filter(isRecord);
	const firstPath = readString(changes[0]?.path);

	return {
		type: "host-event",
		kind: "tool-call",
		summary: firstPath ?? "Apply patch",
		data: {
			input: firstPath ? { file_path: firstPath } : {},
			toolName: "Edit",
			toolUseId: readString(item.id),
		},
		rawProviderEvent: item,
	};
}

function mapCodexFileChangeResult(item: CodexJsonObject): ProviderAdapterEvent {
	const diffs = readArray(item.changes)
		.filter(isRecord)
		.map((change) => readString(change.diff))
		.filter((diff): diff is string => diff !== null)
		.join("\n\n");
	const status = readString(item.status);

	return {
		type: "host-event",
		kind: "tool-result",
		summary: status === "declined" ? "Patch declined" : "Patch finished",
		data: {
			isError: status === "failed" || status === "declined",
			output: diffs,
			toolUseId: readString(item.id),
		},
		rawProviderEvent: item,
	};
}

function mapCodexMcpToolCall(item: CodexJsonObject): ProviderAdapterEvent {
	const server = readString(item.server) ?? "mcp";
	const tool = readString(item.tool) ?? "tool";
	const argumentsValue = item.arguments ?? null;

	return {
		type: "host-event",
		kind: "tool-call",
		summary: `${server}/${tool}`,
		data: {
			input: { arguments: argumentsValue, server, tool },
			inputJson: JSON.stringify(argumentsValue),
			toolName: "MCP",
			toolUseId: readString(item.id),
		},
		rawProviderEvent: item,
	};
}

function mapCodexMcpToolResult(item: CodexJsonObject): ProviderAdapterEvent {
	const result = isRecord(item.result) ? item.result : null;
	const content = result?.content ?? item.error ?? null;

	return {
		type: "host-event",
		kind: "tool-result",
		summary: "MCP tool finished",
		data: {
			isError: item.error !== null && item.error !== undefined,
			output: JSON.stringify(content),
			toolUseId: readString(item.id),
		},
		rawProviderEvent: item,
	};
}

function mapCodexDynamicToolCall(item: CodexJsonObject): ProviderAdapterEvent {
	return {
		type: "host-event",
		kind: "tool-call",
		summary: readString(item.tool) ?? "Dynamic tool",
		data: {
			input: { arguments: item.arguments ?? null },
			inputJson: JSON.stringify(item.arguments ?? null),
			toolName: readString(item.tool) ?? "DynamicTool",
			toolUseId: readString(item.id),
		},
		rawProviderEvent: item,
	};
}

function mapCodexDynamicToolResult(item: CodexJsonObject): ProviderAdapterEvent {
	return {
		type: "host-event",
		kind: "tool-result",
		summary: "Dynamic tool finished",
		data: {
			isError: item.success === false,
			output: JSON.stringify(item.contentItems ?? null),
			toolUseId: readString(item.id),
		},
		rawProviderEvent: item,
	};
}

function mapCodexCollabToolCall(item: CodexJsonObject): ProviderAdapterEvent {
	return {
		type: "host-event",
		kind: "tool-call",
		summary: readString(item.prompt) ?? readString(item.tool) ?? "Sub-agent",
		data: {
			input: {
				description: readString(item.prompt) ?? readString(item.tool) ?? "Sub-agent",
				receiverThreadIds: item.receiverThreadIds ?? null,
			},
			toolName: "Agent",
			toolUseId: readString(item.id),
		},
		rawProviderEvent: item,
	};
}

function mapCodexCollabToolResult(item: CodexJsonObject): ProviderAdapterEvent {
	return {
		type: "host-event",
		kind: "tool-result",
		summary: "Sub-agent finished",
		data: {
			isError: false,
			output: JSON.stringify(item.agentsStates ?? null),
			toolUseId: readString(item.id),
		},
		rawProviderEvent: item,
	};
}

function mapCodexWebSearchCall(item: CodexJsonObject): ProviderAdapterEvent {
	return {
		type: "host-event",
		kind: "tool-call",
		summary: readString(item.query) ?? "Web search",
		data: {
			input: { action: item.action ?? null, query: readString(item.query) ?? "" },
			toolName: "WebSearch",
			toolUseId: readString(item.id),
		},
		rawProviderEvent: item,
	};
}

function mapCodexImageViewCall(item: CodexJsonObject): ProviderAdapterEvent {
	return {
		type: "host-event",
		kind: "tool-call",
		summary: readString(item.path) ?? "Image view",
		data: {
			input: { file_path: readString(item.path) ?? "" },
			toolName: "ViewImage",
			toolUseId: readString(item.id),
		},
		rawProviderEvent: item,
	};
}

function mapCodexImageViewResult(item: CodexJsonObject): ProviderAdapterEvent {
	return {
		type: "host-event",
		kind: "tool-result",
		summary: "Image viewed",
		data: {
			isError: false,
			output: readString(item.path) ?? "",
			toolUseId: readString(item.id),
		},
		rawProviderEvent: item,
	};
}

function mapCodexWebSearchResult(item: CodexJsonObject): ProviderAdapterEvent {
	return {
		type: "host-event",
		kind: "tool-result",
		summary: "Web search finished",
		data: {
			isError: false,
			output: JSON.stringify(item.action ?? null),
			toolUseId: readString(item.id),
		},
		rawProviderEvent: item,
	};
}

function mapCodexItemStarted(item: CodexJsonObject): ProviderAdapterEvent | null {
	switch (readString(item.type)) {
		case "commandExecution":
			return mapCodexCommandCall(item);
		case "fileChange":
			return mapCodexFileChangeCall(item);
		case "mcpToolCall":
			return mapCodexMcpToolCall(item);
		case "dynamicToolCall":
			return mapCodexDynamicToolCall(item);
		case "collabAgentToolCall":
			return mapCodexCollabToolCall(item);
		case "webSearch":
			return mapCodexWebSearchCall(item);
		case "imageView":
			return mapCodexImageViewCall(item);
		case "enteredReviewMode":
			return {
				type: "host-event",
				kind: "system",
				summary: "Review started",
				data: { review: readString(item.review) },
				rawProviderEvent: item,
			};
		case "exitedReviewMode":
			return {
				type: "host-event",
				kind: "system",
				summary: "Review finished",
				data: { review: readString(item.review) },
				rawProviderEvent: item,
			};
		case "contextCompaction":
			return {
				type: "host-event",
				kind: "system",
				summary: "Context compacted",
				data: {},
				rawProviderEvent: item,
			};
		default:
			return null;
	}
}

function mapCodexItemCompleted(item: CodexJsonObject): ProviderAdapterEvent | null {
	switch (readString(item.type)) {
		case "commandExecution":
			return mapCodexCommandResult(item);
		case "fileChange":
			return mapCodexFileChangeResult(item);
		case "mcpToolCall":
			return mapCodexMcpToolResult(item);
		case "dynamicToolCall":
			return mapCodexDynamicToolResult(item);
		case "collabAgentToolCall":
			return mapCodexCollabToolResult(item);
		case "webSearch":
			return mapCodexWebSearchResult(item);
		case "imageView":
			return mapCodexImageViewResult(item);
		case "plan":
			if (!readString(item.text)) {
				return null;
			}

			return {
				type: "host-event",
				kind: "system",
				summary: "Plan updated",
				data: { text: readString(item.text) },
				rawProviderEvent: item,
			};
		default:
			return null;
	}
}

function buildCodexPendingRequest(
	requestId: string,
	request: CodexPendingRequest,
): ProviderAdapterEvent | null {
	switch (request.method) {
		case "item/commandExecution/requestApproval": {
			const command = readString(request.params.command);
			const cwd = readString(request.params.cwd);
			const reason = readString(request.params.reason);
			const target =
				command && cwd ? `Allow Codex to run \`${command}\` in ${cwd}?` : "Allow Codex to run this command?";

			return {
				type: "pending-request",
				kind: "approval",
				blockReason: "permission",
				prompt: reason ? `${target} ${reason}` : target,
				data: {
					command,
					cwd,
					requestId,
					toolUseId: readString(request.params.itemId),
				},
			};
		}
		case "item/fileChange/requestApproval": {
			const reason = readString(request.params.reason);
			const prompt = reason ? `Allow Codex to apply this patch? ${reason}` : "Allow Codex to apply this patch?";

			return {
				type: "pending-request",
				kind: "approval",
				blockReason: "permission",
				prompt,
				data: {
					requestId,
					toolUseId: readString(request.params.itemId),
				},
			};
		}
		case "item/permissions/requestApproval": {
			const permissions = isRecord(request.params.permissions) ? request.params.permissions : null;
			const fileSystem = isRecord(permissions?.fileSystem) ? permissions.fileSystem : null;
			const network = isRecord(permissions?.network) ? permissions.network : null;
			const readRoots = readArray(fileSystem?.read).length;
			const writeRoots = readArray(fileSystem?.write).length;
			const wantsNetwork = network?.enabled === true;
			const labels = [
				wantsNetwork ? "network access" : null,
				readRoots > 0 ? `read ${readRoots} extra path${readRoots === 1 ? "" : "s"}` : null,
				writeRoots > 0 ? `write ${writeRoots} extra path${writeRoots === 1 ? "" : "s"}` : null,
			].filter((label): label is string => label !== null);
			const reason = readString(request.params.reason);
			const prompt =
				labels.length > 0
					? `Allow Codex to request ${labels.join(", ")}${reason ? `? ${reason}` : "?"}`
					: `Allow Codex to request additional permissions${reason ? `? ${reason}` : "?"}`;

			return {
				type: "pending-request",
				kind: "approval",
				blockReason: "sandbox",
				prompt,
				data: {
					permissions,
					requestId,
					toolUseId: readString(request.params.itemId),
				},
			};
		}
		default:
			return null;
	}
}

function pushCodexTurnEvent(liveSession: CodexLiveSession, event: ProviderAdapterEvent) {
	if (!liveSession.turnState) {
		return;
	}

	if (event.type === "host-event" && event.kind === "text" && liveSession.model) {
		liveSession.turnState.stream.push({
			...event,
			data: {
				...event.data,
				model: liveSession.model,
			},
		});
		return;
	}

	liveSession.turnState.stream.push(event);
}

function finishCodexTurn(liveSession: CodexLiveSession) {
	liveSession.turnState?.stream.finish();
	liveSession.turnState = null;
	liveSession.activeTurnId = null;
	scheduleCodexLiveSessionIdleClose(liveSession);
}

function failCodexTurn(liveSession: CodexLiveSession, error: unknown) {
	liveSession.turnState?.stream.fail(error);
	liveSession.turnState = null;
	liveSession.activeTurnId = null;
}

function scheduleCodexLiveSessionIdleClose(liveSession: CodexLiveSession) {
	if (liveSession.idleTimer) {
		clearTimeout(liveSession.idleTimer);
	}

	if (liveSession.turnState || liveSession.pendingRequests.size > 0 || liveSession.stopping) {
		liveSession.idleTimer = null;
		return;
	}

	liveSession.idleTimer = setTimeout(() => {
		liveSession.close("idle");
	}, CODEX_IDLE_TIMEOUT_MS);
}

function rejectCodexPendingResponses(liveSession: CodexLiveSession, error: Error) {
	for (const [requestId, pendingResponse] of liveSession.pendingResponses) {
		liveSession.pendingResponses.delete(requestId);
		pendingResponse.reject(error);
	}
}

function writeCodexFrame(liveSession: CodexLiveSession, frame: CodexJsonObject) {
	sessionStore.appendProtocolFrame(liveSession.sessionId, {
		provider: "codex",
		direction: "out",
		frame,
	});
	void liveSession.subprocess.stdin.write(`${JSON.stringify(frame)}\n`);
	void liveSession.subprocess.stdin.flush();
}

function createCodexLiveSession(session: HostSession) {
	const abortController = new AbortController();
	const subprocess = Bun.spawn([getCodexBin(), "app-server", "--listen", "stdio://"], {
		cwd: session.cwd,
		env: Bun.env,
		signal: abortController.signal,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const liveSession: CodexLiveSession = {
		activeTurnId: null,
		abortController,
		cwd: session.cwd,
		idleTimer: null,
		model: session.model,
		pendingRequests: new Map(),
		pendingResponses: new Map(),
		sessionId: session.id,
		stderrChunks: [],
		stopping: false,
		subprocess,
		threadId: null,
		turnState: null,
		write(frame) {
			writeCodexFrame(liveSession, frame);
		},
		close() {
			if (liveSession.stopping) {
				return;
			}

			liveSession.stopping = true;

			if (liveSession.idleTimer) {
				clearTimeout(liveSession.idleTimer);
				liveSession.idleTimer = null;
			}

			if (activeCodexSessions.get(session.id) === liveSession) {
				activeCodexSessions.delete(session.id);
			}

			rejectCodexPendingResponses(liveSession, new Error("Codex app-server closed"));

			try {
				void subprocess.stdin.end();
			} catch {}
		},
	};

	void runCodexLiveSession(liveSession);

	return liveSession;
}

async function sendCodexRequest(
	liveSession: CodexLiveSession,
	method: string,
	params?: CodexJsonObject,
) {
	const requestId = Bun.randomUUIDv7();

	return await new Promise<CodexJsonObject>((resolve, reject) => {
		liveSession.pendingResponses.set(requestId, { resolve, reject });
		liveSession.write(params ? { id: requestId, method, params } : { id: requestId, method });
	});
}

function sendCodexNotification(liveSession: CodexLiveSession, method: string) {
	liveSession.write({ method });
}

function sendCodexResponse(
	liveSession: CodexLiveSession,
	requestId: CodexRpcId,
	result: CodexJsonObject,
) {
	liveSession.write({ id: requestId, result });
}

function sendCodexErrorResponse(
	liveSession: CodexLiveSession,
	requestId: CodexRpcId,
	message: string,
) {
	liveSession.write({
		error: {
			code: -32000,
			message,
		},
		id: requestId,
	});
}

async function requestCodexAppServer(
	subprocess: Bun.Subprocess<"pipe", "pipe", "pipe">,
	pendingResponses: Map<string, CodexPendingResponse>,
	method: string,
	params?: CodexJsonObject,
) {
	const requestId = Bun.randomUUIDv7();

	return await new Promise<CodexJsonObject>((resolve, reject) => {
		pendingResponses.set(requestId, { resolve, reject });
		void subprocess.stdin.write(
			`${JSON.stringify(params ? { id: requestId, method, params } : { id: requestId, method })}\n`,
		);
		void subprocess.stdin.flush();
	});
}

async function loadCodexModels() {
	const subprocess = Bun.spawn([getCodexBin(), "app-server", "--listen", "stdio://"], {
		cwd: process.cwd(),
		env: Bun.env,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdoutReader = subprocess.stdout.getReader();
	const stderrReader = subprocess.stderr.getReader();
	const pendingResponses = new Map<string, CodexPendingResponse>();
	const stderrChunks: Uint8Array[] = [];
	let buffer = "";

	const stderrPromise = (async () => {
		for (;;) {
			const { done, value } = await stderrReader.read();

			if (done) {
				return;
			}

			stderrChunks.push(value);
		}
	})();

	const stdoutPromise = (async () => {
		for (;;) {
			const { done, value } = await stdoutReader.read();

			if (done) {
				return;
			}

			buffer += decoder.decode(value);
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";

			for (const line of lines) {
				const trimmed = line.trim();

				if (trimmed.length === 0) {
					continue;
				}

				const frame = JSON.parse(trimmed);

				if (!isRecord(frame)) {
					continue;
				}

				const requestId = stringifyRpcId(frame.id);

				if (!requestId) {
					continue;
				}

				const pendingResponse = pendingResponses.get(requestId);

				if (!pendingResponse) {
					continue;
				}

				pendingResponses.delete(requestId);

				if (frame.error !== undefined) {
					pendingResponse.reject(new Error(readCodexError(frame.error)));
					continue;
				}

				pendingResponse.resolve(isRecord(frame.result) ? frame.result : {});
			}
		}
	})();

	try {
		await requestCodexAppServer(subprocess, pendingResponses, "initialize", {
			capabilities: {
				experimentalApi: false,
				optOutNotificationMethods: [],
			},
			clientInfo: {
				name: "shelleport",
				title: "Shelleport",
				version: "0.0.0",
			},
		});
		void subprocess.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
		void subprocess.stdin.flush();

		const models: ProviderModel[] = [];
		let cursor: string | null = null;

		for (;;) {
			const result = await requestCodexAppServer(subprocess, pendingResponses, "model/list", {
				cursor: cursor ?? undefined,
				includeHidden: false,
				limit: 100,
			});
			const data = readArray(result.data).filter(isRecord);

			for (const entry of data) {
				const model = mapCodexModel(entry);

				if (model) {
					models.push(model);
				}
			}

			cursor = readString(result.nextCursor);

			if (!cursor) {
				return models;
			}
		}
	} finally {
		for (const [requestId, pendingResponse] of pendingResponses) {
			pendingResponses.delete(requestId);
			pendingResponse.reject(new Error("Codex app-server closed"));
		}

		try {
			void subprocess.stdin.end();
		} catch {}

		await stdoutPromise.catch(() => {});
		await stderrPromise;
		stdoutReader.releaseLock();
		stderrReader.releaseLock();

		const exitCode = await subprocess.exited;

		if (exitCode !== 0) {
			const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
			throw new Error(stderr || `Codex app-server exited with code ${exitCode}`);
		}
	}
}

async function getCodexModels() {
	if (codexModelCache && codexModelCache.expiresAt > Date.now()) {
		return codexModelCache.models;
	}

	if (!codexModelRequest) {
		codexModelRequest = loadCodexModels()
			.then((models) => {
				codexModelCache = {
					expiresAt: Date.now() + CODEX_MODEL_CACHE_TTL_MS,
					models,
				};
				return models;
			})
			.finally(() => {
				codexModelRequest = null;
			});
	}

	return await codexModelRequest;
}

function handleCodexServerRequest(
	liveSession: CodexLiveSession,
	requestId: CodexRpcId,
	method: string,
	params: CodexJsonObject,
) {
	const requestKey = String(requestId);
	const request: CodexPendingRequest = {
		id: requestId,
		method,
		params,
	};
	const pendingEvent = buildCodexPendingRequest(requestKey, request);

	if (pendingEvent) {
		liveSession.pendingRequests.set(requestKey, request);
		pushCodexTurnEvent(liveSession, pendingEvent);
		return;
	}

	sendCodexErrorResponse(
		liveSession,
		requestId,
		`Shelleport does not support Codex server request ${method}`,
	);
	pushCodexTurnEvent(liveSession, {
		type: "host-event",
		kind: "error",
		summary: "Unsupported Codex request",
		data: { method },
		rawProviderEvent: { id: requestId, method, params },
	});
}

function handleCodexItemStarted(liveSession: CodexLiveSession, params: CodexJsonObject) {
	const item = isRecord(params.item) ? params.item : null;

	if (!item) {
		return;
	}

	const event = mapCodexItemStarted(item);

	if (event) {
		pushCodexTurnEvent(liveSession, event);
	}
}

function handleCodexReasoningDelta(liveSession: CodexLiveSession, params: CodexJsonObject) {
	if (!liveSession.turnState) {
		return;
	}

	const itemId = readString(params.itemId);
	const delta = readString(params.delta);

	if (!itemId || !delta) {
		return;
	}

	const accumulated = liveSession.turnState.thinkingTextByItemId.get(itemId) ?? "";
	liveSession.turnState.thinkingTextByItemId.set(itemId, `${accumulated}${delta}`);
	pushCodexTurnEvent(liveSession, {
		type: "host-event",
		kind: "text",
		summary: "Codex reasoning",
		data: {
			role: "thinking",
			text: delta,
		},
		rawProviderEvent: params,
	});
}

function handleCodexAgentMessageDelta(liveSession: CodexLiveSession, params: CodexJsonObject) {
	if (!liveSession.turnState) {
		return;
	}

	const itemId = readString(params.itemId);
	const delta = readString(params.delta);

	if (!itemId || !delta) {
		return;
	}

	const accumulated = liveSession.turnState.agentTextByItemId.get(itemId) ?? "";
	liveSession.turnState.agentTextByItemId.set(itemId, `${accumulated}${delta}`);
	pushCodexTurnEvent(liveSession, {
		type: "host-event",
		kind: "text",
		summary: "Codex reply",
		data: {
			role: "assistant",
			text: delta,
		},
		rawProviderEvent: params,
	});
}

function flushCodexCompletedText(
	liveSession: CodexLiveSession,
	itemId: string,
	role: "assistant" | "thinking",
	text: string,
	rawProviderEvent: CodexJsonObject,
) {
	if (!liveSession.turnState || text.length === 0) {
		return;
	}

	const stateMap =
		role === "assistant"
			? liveSession.turnState.agentTextByItemId
			: liveSession.turnState.thinkingTextByItemId;
	const streamed = stateMap.get(itemId) ?? "";
	stateMap.delete(itemId);

	if (!text.startsWith(streamed)) {
		pushCodexTurnEvent(liveSession, {
			type: "host-event",
			kind: "text",
			summary: role === "assistant" ? "Codex reply" : "Codex reasoning",
			data: {
				role,
				text,
			},
			rawProviderEvent,
		});
		return;
	}

	const remainder = text.slice(streamed.length);

	if (remainder.length === 0) {
		return;
	}

	pushCodexTurnEvent(liveSession, {
		type: "host-event",
		kind: "text",
		summary: role === "assistant" ? "Codex reply" : "Codex reasoning",
		data: {
			role,
			text: remainder,
		},
		rawProviderEvent,
	});
}

function handleCodexItemCompleted(liveSession: CodexLiveSession, params: CodexJsonObject) {
	const item = isRecord(params.item) ? params.item : null;

	if (!item) {
		return;
	}

	const itemId = readString(item.id);
	const itemType = readString(item.type);

	if (itemId && itemType === "agentMessage") {
		flushCodexCompletedText(
			liveSession,
			itemId,
			"assistant",
			readString(item.text) ?? "",
			item,
		);
	}

	if (itemId && itemType === "reasoning") {
		const summaryText = readArray(item.summary)
			.map((part) => readString(part))
			.filter((part): part is string => part !== null)
			.join("");
		const contentText = readArray(item.content)
			.map((part) => readString(part))
			.filter((part): part is string => part !== null)
			.join("");
		flushCodexCompletedText(
			liveSession,
			itemId,
			"thinking",
			summaryText || contentText,
			item,
		);
	}

	const event = mapCodexItemCompleted(item);

	if (event) {
		pushCodexTurnEvent(liveSession, event);
	}
}

function handleCodexNotification(
	liveSession: CodexLiveSession,
	method: string,
	params: CodexJsonObject,
) {
	switch (method) {
		case "account/rateLimits/updated": {
			const rateLimits = isRecord(params.rateLimits) ? params.rateLimits : null;
			const primary = isRecord(rateLimits?.primary) ? rateLimits.primary : null;
			const resetsAt = readNumber(primary?.resetsAt);
			const windowDuration = readNumber(primary?.windowDurationMins);
			const usedPercent = readNumber(primary?.usedPercent);

			pushCodexTurnEvent(liveSession, {
				type: "host-event",
				kind: "system",
				summary: "Rate limit update",
				data: {
					limit:
						resetsAt === null || windowDuration === null || usedPercent === null
							? null
							: {
									isUsingOverage: null,
									resetsAt: resetsAt * 1000,
									status: null,
									utilization: usedPercent / 100,
									window: `${windowDuration}m`,
								},
				},
				rawProviderEvent: params,
			});
			return;
		}
		case "error": {
			const error = isRecord(params.error) ? params.error : null;

			if (liveSession.turnState) {
				liveSession.turnState.errorReported = true;
			}

			pushCodexTurnEvent(liveSession, {
				type: "host-event",
				kind: "error",
				summary: "Codex turn failed",
				data: { message: readString(error?.message) ?? "Codex turn failed" },
				rawProviderEvent: params,
			});
			return;
		}
		case "item/agentMessage/delta":
			handleCodexAgentMessageDelta(liveSession, params);
			return;
		case "item/completed":
			handleCodexItemCompleted(liveSession, params);
			return;
		case "item/started":
			handleCodexItemStarted(liveSession, params);
			return;
		case "item/reasoning/summaryTextDelta":
			handleCodexReasoningDelta(liveSession, params);
			return;
		case "model/rerouted": {
			const nextModel = readString(params.toModel);

			if (nextModel) {
				liveSession.model = nextModel;
			}

			pushCodexTurnEvent(liveSession, {
				type: "host-event",
				kind: "system",
				summary: "Model rerouted",
				data: {
					fromModel: readString(params.fromModel),
					toModel: nextModel,
				},
				rawProviderEvent: params,
			});
			return;
		}
		case "serverRequest/resolved": {
			const requestKey = stringifyRpcId(params.requestId);

			if (!requestKey) {
				return;
			}

			liveSession.pendingRequests.delete(requestKey);
			pushCodexTurnEvent(liveSession, {
				type: "pending-request-cleared",
				requestId: requestKey,
			});
			return;
		}
		case "thread/status/changed": {
			const status = isRecord(params.status) ? params.status : null;

			if (readString(status?.type) === "systemError") {
				pushCodexTurnEvent(liveSession, {
					type: "session-status",
					status: "failed",
					detail: {
						message: "Codex thread entered systemError state.",
					},
				});
			}

			return;
		}
		case "thread/tokenUsage/updated": {
			const tokenUsage = isRecord(params.tokenUsage) ? params.tokenUsage : null;
			const total = isRecord(tokenUsage?.total) ? tokenUsage.total : null;
			const usage = total ? createCodexUsage(total, liveSession.model) : null;

			pushCodexTurnEvent(liveSession, {
				type: "host-event",
				kind: "system",
				summary: "Rate limit update",
				data: { usage },
				rawProviderEvent: params,
			});
			return;
		}
		case "turn/completed": {
			const turn = isRecord(params.turn) ? params.turn : null;
			const status = readString(turn?.status);
			const error = isRecord(turn?.error) ? turn.error : null;

			if (status === "failed") {
				if (!liveSession.turnState?.errorReported) {
					pushCodexTurnEvent(liveSession, {
						type: "host-event",
						kind: "error",
						summary: "Codex turn failed",
						data: {
							message: readString(error?.message) ?? "Codex turn failed",
						},
						rawProviderEvent: params,
					});
				}

				pushCodexTurnEvent(liveSession, {
					type: "session-status",
					status: "failed",
					detail: {
						message: readString(error?.message),
					},
				});
				finishCodexTurn(liveSession);
				return;
			}

			if (status === "interrupted") {
				pushCodexTurnEvent(liveSession, {
					type: "host-event",
					kind: "system",
					summary: "Session interrupted",
					data: {},
					rawProviderEvent: params,
				});
				pushCodexTurnEvent(liveSession, {
					type: "session-status",
					status: "interrupted",
					detail: {},
				});
				finishCodexTurn(liveSession);
				return;
			}

			pushCodexTurnEvent(liveSession, {
				type: "session-status",
				status: "idle",
				detail: {},
			});
			finishCodexTurn(liveSession);
			return;
		}
		case "turn/started": {
			const turn = isRecord(params.turn) ? params.turn : null;
			const turnId = readString(turn?.id);

			if (turnId) {
				liveSession.activeTurnId = turnId;
			}

			return;
		}
		default:
			return;
	}
}

async function runCodexLiveSession(liveSession: CodexLiveSession) {
	const stdoutReader = liveSession.subprocess.stdout.getReader();
	const stderrReader = liveSession.subprocess.stderr.getReader();
	let buffer = "";

	const stderrPromise = (async () => {
		for (;;) {
			const { done, value } = await stderrReader.read();

			if (done) {
				return;
			}

			liveSession.stderrChunks.push(value);
		}
	})();

	function handleCodexFrame(frame: CodexJsonObject) {
		sessionStore.appendProtocolFrame(liveSession.sessionId, {
			provider: "codex",
			direction: "in",
			frame,
		});

		const requestId = stringifyRpcId(frame.id);
		const method = readString(frame.method);

		if (requestId && method) {
			handleCodexServerRequest(
				liveSession,
				typeof frame.id === "number" || typeof frame.id === "string" ? frame.id : requestId,
				method,
				isRecord(frame.params) ? frame.params : {},
			);
			return;
		}

		if (requestId) {
			const pending = liveSession.pendingResponses.get(requestId);

			if (!pending) {
				return;
			}

			liveSession.pendingResponses.delete(requestId);

			if (frame.error !== undefined) {
				pending.reject(new Error(readCodexError(frame.error)));
				return;
			}

			pending.resolve(isRecord(frame.result) ? frame.result : {});
			return;
		}

		if (!method) {
			return;
		}

		handleCodexNotification(liveSession, method, isRecord(frame.params) ? frame.params : {});
	}

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

				const parsed = JSON.parse(trimmed);

				if (isRecord(parsed)) {
					handleCodexFrame(parsed);
				}
			}
		}

		if (buffer.trim().length > 0) {
			const parsed = JSON.parse(buffer.trim());

			if (isRecord(parsed)) {
				handleCodexFrame(parsed);
			}
		}
	} catch (error) {
		failCodexTurn(liveSession, error);
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

	if (activeCodexSessions.get(liveSession.sessionId) === liveSession) {
		activeCodexSessions.delete(liveSession.sessionId);
	}

	if (liveSession.pendingResponses.size > 0) {
		const stderr = Buffer.concat(liveSession.stderrChunks).toString("utf8").trim();
		const message =
			exitCode === 0
				? "Codex app-server closed before replying"
				: stderr || `Codex app-server exited with code ${exitCode}`;
		rejectCodexPendingResponses(liveSession, new Error(message));
	}

	if (exitCode !== 0 && !liveSession.stopping) {
		pushCodexTurnEvent(liveSession, {
			type: "host-event",
			kind: "error",
			summary: "Codex CLI error",
			data: {
				exitCode,
				stderr: Buffer.concat(liveSession.stderrChunks).toString("utf8").trim(),
			},
			rawProviderEvent: null,
		});
	}

	if (liveSession.turnState) {
		finishCodexTurn(liveSession);
	}
}

async function initializeCodexSession(liveSession: CodexLiveSession, session: HostSession) {
	await sendCodexRequest(liveSession, "initialize", {
		capabilities: {
			experimentalApi: false,
			optOutNotificationMethods: [
				"command/exec/outputDelta",
				"item/commandExecution/outputDelta",
				"item/fileChange/outputDelta",
				"item/plan/delta",
				"item/reasoning/summaryPartAdded",
				"item/reasoning/textDelta",
			],
		},
		clientInfo: {
			name: "shelleport",
			title: "Shelleport",
			version: "0.0.0",
		},
	});
	sendCodexNotification(liveSession, "initialized");

	const threadRequest = createCodexThreadRequest(session);
	const result = await sendCodexRequest(liveSession, threadRequest.method, threadRequest.params);
	const thread = readCodexResponseThread(result);
	liveSession.threadId = thread.threadId;
	liveSession.model = thread.model ?? liveSession.model;
}

async function ensureCodexLiveSession(session: HostSession) {
	const existing = activeCodexSessions.get(session.id);

	if (existing) {
		if (existing.idleTimer) {
			clearTimeout(existing.idleTimer);
			existing.idleTimer = null;
		}

		return existing;
	}

	const liveSession = createCodexLiveSession(session);
	activeCodexSessions.set(session.id, liveSession);

	try {
		await initializeCodexSession(liveSession, session);
		return liveSession;
	} catch (error) {
		liveSession.close("startup");
		throw error;
	}
}

function createCodexTurnState() {
	return {
		agentTextByItemId: new Map<string, string>(),
		errorReported: false,
		stream: createCodexTurnStream(),
		thinkingTextByItemId: new Map<string, string>(),
	} satisfies CodexTurnState;
}

function startCodexTurn(
	liveSession: CodexLiveSession,
	runInput: ProviderAdapterRunInput,
	turnState: CodexTurnState,
) {
	if (!liveSession.threadId) {
		throw new Error("Codex session is not initialized");
	}

	liveSession.turnState = turnState;

	return sendCodexRequest(liveSession, "turn/start", {
		effort: getCodexEffort(runInput.session.effort),
		input: buildCodexUserInput(runInput.prompt, runInput.attachments),
		model: runInput.session.model ?? undefined,
		threadId: liveSession.threadId,
	});
}

function streamCodexTurn(runInput: ProviderAdapterRunInput): AsyncGenerator<ProviderAdapterEvent> {
	return (async function* () {
		const turnState = createCodexTurnState();

		void (async () => {
			try {
				const liveSession = await ensureCodexLiveSession(runInput.session);
				runInput.signal.addEventListener(
					"abort",
					() => {
						if (liveSession.turnState === turnState) {
							liveSession.close("terminate");
						}
					},
					{ once: true },
				);
				turnState.stream.push({
					type: "provider-session",
					providerSessionRef: liveSession.threadId ?? runInput.session.providerSessionRef ?? "",
				});
				const turnId = readCodexTurnId(await startCodexTurn(liveSession, runInput, turnState));
				liveSession.activeTurnId = turnId;
			} catch (error) {
				turnState.stream.fail(error);
			}
		})();

		yield* turnState.stream.iterate();
	})();
}

export async function parseCodexHistoricalSession(path: string): Promise<HistoricalSession | null> {
	const headLines = await readHeadJsonl(path);
	const meta = headLines.find((line) => line.type === "session_meta");

	if (!meta || !meta.payload || typeof meta.payload !== "object") {
		return null;
	}

	const payload = meta.payload as Record<string, unknown>;
	const cwd = typeof payload.cwd === "string" ? payload.cwd : "";

	if (cwd.length === 0) {
		return null;
	}

	const stats = await Bun.file(path).stat();
	const providerSessionRef = typeof payload.id === "string" ? payload.id : basename(path, ".jsonl");
	const previewLine = headLines.find((line) => line.type === "response_item");
	const preview =
		previewLine && previewLine.payload && typeof previewLine.payload === "object"
			? JSON.stringify(previewLine.payload).slice(0, 200)
			: "";

	return {
		provider: "codex",
		providerSessionRef,
		title:
			typeof payload.originator === "string"
				? `${payload.originator} ${providerSessionRef}`
				: providerSessionRef,
		cwd,
		sourcePath: path,
		createTime:
			typeof payload.timestamp === "string" ? Date.parse(payload.timestamp) : stats.mtimeMs,
		updateTime: stats.mtimeMs,
		preview,
	};
}

export class CodexProviderAdapter implements ProviderAdapter {
	readonly id = "codex" as const;
	readonly label = "Codex";

	capabilities() {
		return codexCapabilities;
	}

	async summary(): Promise<ProviderSummary> {
		const isAvailable = Bun.which(getCodexBin()) !== null;
		const models = isAvailable ? await getCodexModels().catch(() => []) : [];

		return {
			id: this.id,
			label: this.label,
			status: isAvailable ? "ready" : "partial",
			statusDetail: isAvailable
				? null
				: "Codex CLI not found in PATH. Install it or set SHELLEPORT_CODEX_BIN.",
			capabilities: this.capabilities(),
			models,
		};
	}

	sendInput(runInput: ProviderAdapterRunInput) {
		return streamCodexTurn(runInput);
	}

	resumeSession(_session: HostSession, runInput: ProviderAdapterRunInput) {
		return streamCodexTurn(runInput);
	}

	async listHistoricalSessions() {
		const rootPath = `${Bun.env.HOME ?? ""}/.codex/sessions`;
		const fileList = await listJsonlFiles(rootPath);
		const sessions = await Promise.all(fileList.map(parseCodexHistoricalSession));
		return sessions
			.filter((session) => session !== null)
			.sort((left, right) => right.updateTime - left.updateTime);
	}

	canHandleRequestResponse(session: HostSession, request: PendingRequest) {
		return activeCodexSessions.has(session.id) && typeof request.data.requestId === "string";
	}

	async respondToRequest(
		session: HostSession,
		request: PendingRequest,
		input: RequestResponsePayload,
	) {
		const liveSession = activeCodexSessions.get(session.id);
		const requestId = typeof request.data.requestId === "string" ? request.data.requestId : null;

		if (!liveSession || !requestId) {
			throw new Error("Codex request is no longer active");
		}

		const pendingRequest = liveSession.pendingRequests.get(requestId);

		if (!pendingRequest) {
			throw new Error("Codex request is no longer pending");
		}

		liveSession.pendingRequests.delete(requestId);

		if (
			pendingRequest.method === "item/commandExecution/requestApproval" ||
			pendingRequest.method === "item/fileChange/requestApproval"
		) {
			sendCodexResponse(liveSession, pendingRequest.id, {
				decision: createCodexRequestDecision(input.decision),
			});
			return;
		}

		if (pendingRequest.method === "item/permissions/requestApproval") {
			const permissions =
				input.decision === "allow" && isRecord(request.data.permissions)
					? request.data.permissions
					: {};

			sendCodexResponse(liveSession, pendingRequest.id, {
				permissions,
				scope: "turn",
			});
			return;
		}

		throw new Error(`Unsupported Codex request type: ${pendingRequest.method}`);
	}

	canHandleControl(session: HostSession) {
		return activeCodexSessions.has(session.id);
	}

	async controlSession(session: HostSession, input: SessionControlPayload) {
		const liveSession = activeCodexSessions.get(session.id);

		if (!liveSession) {
			return;
		}

		if (input.action === "terminate") {
			liveSession.close("terminate");
			return;
		}

		if (!liveSession.threadId || !liveSession.activeTurnId) {
			return;
		}

		await sendCodexRequest(liveSession, "turn/interrupt", {
			threadId: liveSession.threadId,
			turnId: liveSession.activeTurnId,
		}).catch(() => {});
	}

	async deleteSession(session: HostSession) {
		activeCodexSessions.get(session.id)?.close("delete");
	}
}
