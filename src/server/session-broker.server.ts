import type {
	CreateSessionInput,
	HostEvent,
	HostSession,
	ImportSessionPayload,
	PendingRequest,
	QueuedSessionInput,
	QueuedSessionInputUpdatePayload,
	SessionArchivePayload,
	SessionMetaPayload,
	RequestResponsePayload,
	SessionLimit,
	SessionStatusDetail,
	SessionControlPayload,
	SessionInputPayload,
	SessionStreamMessage,
	SessionUsage,
} from "~/shared/shelleport";
import { getDefaultPermissionMode } from "~/shared/shelleport";
import { ApiError } from "~/server/api-error.server";
import { refreshClaudeProviderLimits } from "~/server/providers/claude-usage.server";
import { getProvider } from "~/server/providers/registry.server";
import { sessionStore } from "~/server/store.server";

type ActiveRun = {
	abortController: AbortController;
	done: Promise<void>;
	resolveDone: () => void;
};

type SessionSubscriber = (message: SessionStreamMessage) => void;

const activeRuns = new Map<string, ActiveRun>();
const subscribers = new Map<string, Set<SessionSubscriber>>();

function publish(sessionId: string, message: SessionStreamMessage) {
	const sessionSubscribers = subscribers.get(sessionId);

	if (!sessionSubscribers) {
		return;
	}

	for (const subscriber of sessionSubscribers) {
		subscriber(message);
	}
}

function publishSession(session: HostSession) {
	publish(session.id, {
		type: "session",
		payload: session,
	});
}

function publishEvent(event: HostEvent) {
	publish(event.sessionId, {
		type: "event",
		payload: event,
	});
}

function publishRequest(request: PendingRequest) {
	publish(request.sessionId, {
		type: "request",
		payload: request,
	});
}

function publishQueuedInputs(sessionId: string, queuedInputs: QueuedSessionInput[]) {
	publish(sessionId, {
		type: "queued-inputs",
		payload: queuedInputs,
	});
}

function normalizeAllowedTools(allowedTools: string[]) {
	return [...new Set(allowedTools)].sort();
}

function emptyStatusDetail(): SessionStatusDetail {
	return {
		message: null,
		attempt: null,
		nextRetryTime: null,
		waitKind: null,
		blockReason: null,
	};
}

function readSessionLimit(value: unknown): SessionLimit | null {
	if (!value || typeof value !== "object") {
		return null;
	}

	const limit = value as Record<string, unknown>;

	return {
		status: typeof limit.status === "string" ? limit.status : null,
		resetsAt: typeof limit.resetsAt === "number" ? limit.resetsAt : null,
		window: typeof limit.window === "string" ? limit.window : null,
		isUsingOverage: typeof limit.isUsingOverage === "boolean" ? limit.isUsingOverage : null,
		utilization: typeof limit.utilization === "number" ? limit.utilization : null,
	};
}

function readSessionUsage(value: unknown): SessionUsage | null {
	if (!value || typeof value !== "object") {
		return null;
	}

	const usage = value as Record<string, unknown>;

	if (
		typeof usage.inputTokens !== "number" ||
		typeof usage.outputTokens !== "number" ||
		typeof usage.cacheReadInputTokens !== "number" ||
		typeof usage.cacheCreationInputTokens !== "number"
	) {
		return null;
	}

	return {
		inputTokens: usage.inputTokens,
		outputTokens: usage.outputTokens,
		cacheReadInputTokens: usage.cacheReadInputTokens,
		cacheCreationInputTokens: usage.cacheCreationInputTokens,
		costUsd: typeof usage.costUsd === "number" ? usage.costUsd : null,
		model: typeof usage.model === "string" ? usage.model : null,
	};
}

function updateSessionStatus(
	sessionId: string,
	status: HostSession["status"],
	detail: Partial<SessionStatusDetail> = {},
	update: Partial<
		Pick<HostSession, "pid" | "providerSessionRef" | "title" | "permissionMode" | "allowedTools">
	> = {},
) {
	const updatedSession = sessionStore.updateSession(sessionId, {
		status,
		statusDetail: {
			...emptyStatusDetail(),
			...detail,
		},
		...update,
	});

	if (updatedSession) {
		publishSession(updatedSession);
	}

	return updatedSession;
}

function canStartInputRun(session: HostSession) {
	return (
		!activeRuns.has(session.id) &&
		session.status !== "running" &&
		session.status !== "retrying" &&
		session.status !== "waiting"
	);
}

function publishPromptEvent(sessionId: string, input: SessionInputPayload) {
	const promptEvent = sessionStore.appendEvent(sessionId, {
		kind: "text",
		summary: "User message",
		data: {
			role: "user",
			text: input.prompt,
			attachments: input.attachments,
		},
		rawProviderEvent: null,
	});
	publishEvent(promptEvent);
}

function startNextQueuedInput(sessionId: string) {
	const session = sessionStore.getSession(sessionId);

	if (!session || !canStartInputRun(session) || session.queuedInputCount === 0) {
		return false;
	}

	const queuedInput = sessionStore.shiftQueuedInput(sessionId);

	if (!queuedInput) {
		return false;
	}

	const updatedSession = sessionStore.getSession(sessionId);

	if (updatedSession) {
		publishSession(updatedSession);
	}

	publishQueuedInputs(sessionId, sessionStore.listQueuedInputs(sessionId));

	void consumeProviderRun(sessionId, queuedInput, "send");
	return true;
}

async function consumeProviderRun(
	sessionId: string,
	input: SessionInputPayload,
	mode: "send" | "resume",
) {
	let session = sessionStore.getSession(sessionId);

	if (!session) {
		throw new ApiError(404, "session_not_found", `Unknown session: ${sessionId}`);
	}

	const provider = getProvider(session.provider);
	let resolveDone = () => {};
	const activeRun: ActiveRun = {
		abortController: new AbortController(),
		done: new Promise<void>((resolve) => {
			resolveDone = resolve;
		}),
		resolveDone,
	};

	activeRuns.set(sessionId, activeRun);
	sessionStore.resetSessionUsageProgress(sessionId);
	session = updateSessionStatus(sessionId, "running");

	if (!session) {
		activeRuns.delete(sessionId);
		throw new ApiError(404, "session_not_found", `Unknown session: ${sessionId}`);
	}
	let nextStatus: HostSession["status"] = "idle";
	let nextStatusDetail = emptyStatusDetail();
	let hasPendingRequest = false;
	const generator =
		mode === "resume"
			? provider.resumeSession(session, {
					session,
					prompt: input.prompt,
					attachments: input.attachments,
					signal: activeRun.abortController.signal,
				})
			: provider.sendInput({
					session,
					prompt: input.prompt,
					attachments: input.attachments,
					signal: activeRun.abortController.signal,
				});

	try {
		for await (const event of generator) {
			if (event.type === "provider-session") {
				const updatedSession = sessionStore.updateSession(sessionId, {
					providerSessionRef: event.providerSessionRef,
				});

				if (updatedSession) {
					session = updatedSession;
					publishSession(updatedSession);
				}

				continue;
			}

			if (event.type === "pending-request") {
				hasPendingRequest = true;
				const request = sessionStore.createPendingRequest({
					sessionId,
					provider: session.provider,
					kind: event.kind,
					blockReason: event.blockReason,
					prompt: event.prompt,
					data: event.data,
				});
				publishRequest(request);
				session =
					updateSessionStatus(sessionId, "waiting", {
						waitKind: event.kind,
						blockReason: event.blockReason,
					}) ?? session;
				continue;
			}

			if (event.type === "session-status") {
				session = updateSessionStatus(sessionId, event.status, event.detail) ?? session;
				continue;
			}

			if (session.status === "retrying") {
				session = updateSessionStatus(sessionId, "running") ?? session;
			}

			const storedEvent = sessionStore.appendEvent(sessionId, event);

			const limit = readSessionLimit(event.data.limit);
			const hasUsage = event.data.usage && typeof event.data.usage === "object";

			if (session.provider === "claude" && limit?.window) {
				sessionStore.saveProviderLimit("claude", limit);
			}

			if (session.provider === "claude" && (limit?.window || hasUsage)) {
				void refreshClaudeProviderLimits();
			}

			const usage = readSessionUsage(event.data.usage);

			if (usage) {
				const updatedSession = sessionStore.updateSessionUsage(sessionId, usage);

				if (updatedSession) {
					session = updatedSession;
					publishSession(updatedSession);
				}
			}

			publishEvent(storedEvent);

			if (event.kind === "error") {
				nextStatus = "failed";
				nextStatusDetail = {
					...emptyStatusDetail(),
					message:
						typeof event.data.message === "string"
							? event.data.message
							: typeof event.data.stderr === "string"
								? event.data.stderr
								: null,
				};
			}
		}
	} catch (error) {
		nextStatus = activeRun.abortController.signal.aborted ? "interrupted" : "failed";
		nextStatusDetail =
			nextStatus === "failed"
				? {
						...emptyStatusDetail(),
						message: error instanceof Error ? error.message : String(error),
					}
				: emptyStatusDetail();
		const storedEvent = sessionStore.appendEvent(sessionId, {
			kind: "error",
			summary: "Run failed",
			data: {
				message: error instanceof Error ? error.message : String(error),
				code: error instanceof ApiError ? error.code : "run_failed",
			},
			rawProviderEvent: null,
		});
		publishEvent(storedEvent);
	} finally {
		activeRuns.delete(sessionId);

		if (nextStatus === "idle" && hasPendingRequest) {
			nextStatus = "waiting";
			nextStatusDetail = session.statusDetail;
		}

		updateSessionStatus(sessionId, nextStatus, nextStatusDetail, { pid: null });
		startNextQueuedInput(sessionId);

		activeRun.resolveDone();
	}
}

export const sessionBroker = {
	recoverInterruptedRuns() {
		const sessions = sessionStore.listSessions();

		for (const session of sessions) {
			if (session.status === "waiting") {
				const detail = sessionStore.getSessionDetail(session.id);
				const hasPendingRequest =
					detail !== null && detail.pendingRequests.some((request) => request.status === "pending");

				if (hasPendingRequest) {
					continue;
				}

				sessionStore.updateSession(session.id, {
					status: "interrupted",
					statusDetail: {
						...emptyStatusDetail(),
						message: "Shelleport restarted while this session was waiting for input.",
					},
					pid: null,
				});
				continue;
			}

			if (session.status !== "running" && session.status !== "retrying") {
				continue;
			}

			sessionStore.updateSession(session.id, {
				status: "interrupted",
				statusDetail: {
					...emptyStatusDetail(),
					message: "Shelleport restarted while this run was active.",
				},
				pid: null,
			});
		}

		for (const session of sessionStore.listSessions()) {
			startNextQueuedInput(session.id);
		}
	},
	listSessions(query?: string) {
		return query && query.trim().length > 0
			? sessionStore.searchSessions(query)
			: sessionStore.listSessions();
	},
	getSessionDetail(sessionId: string, options?: { limit?: number; before?: number }) {
		return sessionStore.getSessionDetail(sessionId, options);
	},
	subscribe(sessionId: string, subscriber: SessionSubscriber) {
		const sessionSubscribers = subscribers.get(sessionId) ?? new Set<SessionSubscriber>();
		sessionSubscribers.add(subscriber);
		subscribers.set(sessionId, sessionSubscribers);

		return () => {
			const currentSubscribers = subscribers.get(sessionId);

			if (!currentSubscribers) {
				return;
			}

			currentSubscribers.delete(subscriber);

			if (currentSubscribers.size === 0) {
				subscribers.delete(sessionId);
			}
		};
	},
	createSession(input: CreateSessionInput) {
		const provider = getProvider(input.provider);
		const providerSummary = provider.summary();

		if (!provider.capabilities().canCreate) {
			throw new ApiError(
				400,
				"provider_cannot_create",
				`${provider.label} cannot start managed sessions in v1`,
			);
		}

		if (providerSummary.status !== "ready") {
			throw new ApiError(
				400,
				"provider_not_ready",
				providerSummary.statusDetail ?? `${provider.label} is not available`,
			);
		}

		const session = sessionStore.createSession({
			provider: input.provider,
			cwd: input.cwd,
			title: input.title?.trim() || `${provider.label} session`,
			permissionMode: input.permissionMode ?? getDefaultPermissionMode(input.provider),
			allowedTools: normalizeAllowedTools(input.allowedTools ?? []),
		});

		if (input.prompt?.trim()) {
			publishPromptEvent(session.id, { prompt: input.prompt, attachments: [] });
			void consumeProviderRun(session.id, { prompt: input.prompt, attachments: [] }, "send");
		}

		return sessionStore.getSession(session.id);
	},
	async importSession(input: ImportSessionPayload) {
		const provider = getProvider(input.provider);
		const historicalSessions = await provider.listHistoricalSessions();
		const historicalSession = historicalSessions.find(
			(session) => session.providerSessionRef === input.providerSessionRef,
		);

		if (!historicalSession) {
			throw new ApiError(404, "historical_session_not_found", "Historical session not found");
		}

		return sessionStore.createSession({
			provider: input.provider,
			cwd: historicalSession.cwd,
			title: historicalSession.title,
			imported: true,
			providerSessionRef: historicalSession.providerSessionRef,
			permissionMode: input.permissionMode ?? getDefaultPermissionMode(input.provider),
			allowedTools: normalizeAllowedTools(input.allowedTools ?? []),
		});
	},
	async sendInput(sessionId: string, input: SessionInputPayload) {
		if (input.prompt.trim().length === 0 && input.attachments.length === 0) {
			throw new ApiError(400, "prompt_required", "Prompt or attachment is required");
		}

		const session = sessionStore.getSession(sessionId);

		if (!session) {
			throw new ApiError(404, "session_not_found", `Unknown session: ${sessionId}`);
		}

		const provider = getProvider(session.provider);

		if (input.attachments.length > 0 && !provider.capabilities().supportsAttachments) {
			throw new ApiError(
				400,
				"provider_no_attachment_support",
				`${provider.label} does not support attachments`,
			);
		}

		publishPromptEvent(sessionId, input);

		if (canStartInputRun(session)) {
			void consumeProviderRun(sessionId, input, "send");
			return sessionStore.getSession(sessionId);
		}

		const updatedSession = sessionStore.enqueueSessionInput(sessionId, input);

		if (updatedSession) {
			publishSession(updatedSession);
		}

		publishQueuedInputs(sessionId, sessionStore.listQueuedInputs(sessionId));

		return updatedSession;
	},
	setSessionArchived(sessionId: string, input: SessionArchivePayload) {
		const session = sessionStore.updateSession(sessionId, { archived: input.archived });

		if (!session) {
			throw new ApiError(404, "session_not_found", `Unknown session: ${sessionId}`);
		}

		publishSession(session);
		return session;
	},
	updateSessionMeta(sessionId: string, input: SessionMetaPayload) {
		const session = sessionStore.updateSession(sessionId, {
			title: input.title?.trim(),
			pinned: input.pinned,
		});

		if (!session) {
			throw new ApiError(404, "session_not_found", `Unknown session: ${sessionId}`);
		}

		publishSession(session);
		return session;
	},
	updateQueuedInput(
		sessionId: string,
		queuedInputId: string,
		input: QueuedSessionInputUpdatePayload,
	) {
		const session = sessionStore.getSession(sessionId);

		if (!session) {
			throw new ApiError(404, "session_not_found", `Unknown session: ${sessionId}`);
		}

		const queuedInput = sessionStore.updateQueuedInput(
			sessionId,
			queuedInputId,
			input.prompt.trim(),
		);

		if (!queuedInput) {
			throw new ApiError(404, "queued_input_not_found", `Unknown queued input: ${queuedInputId}`);
		}

		publishQueuedInputs(sessionId, sessionStore.listQueuedInputs(sessionId));
		return queuedInput;
	},
	deleteQueuedInput(sessionId: string, queuedInputId: string) {
		const queuedInput = sessionStore.getQueuedInput(sessionId, queuedInputId);

		if (!queuedInput) {
			throw new ApiError(404, "queued_input_not_found", `Unknown queued input: ${queuedInputId}`);
		}

		const session = sessionStore.deleteQueuedInput(sessionId, queuedInputId);

		if (!session) {
			throw new ApiError(404, "session_not_found", `Unknown session: ${sessionId}`);
		}

		publishSession(session);
		publishQueuedInputs(sessionId, sessionStore.listQueuedInputs(sessionId));
		return queuedInput;
	},
	controlSession(sessionId: string, input: SessionControlPayload) {
		const activeRun = activeRuns.get(sessionId);

		if (!activeRun) {
			throw new ApiError(409, "session_not_running", "Session is not running");
		}

		activeRun.abortController.abort();

		if (input.action === "terminate") {
			return;
		}
	},
	async respondToRequest(requestId: string, input: RequestResponsePayload) {
		const request = sessionStore.getPendingRequest(requestId);

		if (!request || request.status !== "pending") {
			throw new ApiError(404, "request_not_found", "Pending request not found");
		}

		const session = sessionStore.getSession(request.sessionId);

		if (!session) {
			throw new ApiError(404, "session_not_found", `Unknown session: ${request.sessionId}`);
		}

		const activeRun = activeRuns.get(session.id);

		if (activeRun) {
			await activeRun.done;
		}

		if (input.decision === "deny") {
			const resolvedRequest = sessionStore.resolvePendingRequest(requestId, "rejected", {
				...request.data,
				decision: "deny",
			});
			publishRequest(resolvedRequest);
			updateSessionStatus(session.id, "idle");

			return resolvedRequest;
		}

		const requestedToolRule =
			typeof input.toolRule === "string" && input.toolRule.trim().length > 0
				? input.toolRule.trim()
				: null;
		const storedToolRule =
			typeof request.data.toolRule === "string" && request.data.toolRule.length > 0
				? request.data.toolRule
				: null;
		const toolRule = requestedToolRule ?? storedToolRule;

		if (!toolRule) {
			throw new ApiError(400, "tool_rule_required", "toolRule is required to approve this request");
		}

		const allowedTools = normalizeAllowedTools([...session.allowedTools, toolRule]);
		const updatedSession = sessionStore.updateSession(session.id, {
			status: "running",
			statusDetail: emptyStatusDetail(),
			allowedTools,
		});

		if (!updatedSession) {
			throw new ApiError(404, "session_not_found", `Unknown session: ${session.id}`);
		}

		publishSession(updatedSession);

		const resolvedRequest = sessionStore.resolvePendingRequest(requestId, "resolved", {
			...request.data,
			decision: "allow",
			toolRule,
		});
		publishRequest(resolvedRequest);

		if (!updatedSession.providerSessionRef) {
			throw new ApiError(
				409,
				"session_not_resumable",
				"Session cannot resume without a provider session reference",
			);
		}

		const resumePrompt =
			typeof request.data.resumePrompt === "string" && request.data.resumePrompt.length > 0
				? request.data.resumePrompt
				: "The user approved the blocked request. Retry it if still needed, then continue the task.";

		void consumeProviderRun(updatedSession.id, { prompt: resumePrompt, attachments: [] }, "resume");

		return resolvedRequest;
	},
};
