import type {
	CreateSessionInput,
	HostEvent,
	HostSession,
	ImportSessionPayload,
	PendingRequest,
	RequestResponsePayload,
	SessionControlPayload,
	SessionInputPayload,
	SessionStreamMessage,
} from "~/lib/shelleport";
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

function normalizeAllowedTools(allowedTools: string[]) {
	return [...new Set(allowedTools)].sort();
}

async function consumeProviderRun(sessionId: string, prompt: string, mode: "send" | "resume") {
	let session = sessionStore.getSession(sessionId);

	if (!session) {
		throw new Error(`Unknown session: ${sessionId}`);
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
	session = sessionStore.updateSession(sessionId, { status: "running" });

	if (!session) {
		activeRuns.delete(sessionId);
		throw new Error(`Unknown session: ${sessionId}`);
	}

	publishSession(session);

	let nextStatus: HostSession["status"] = "idle";
	let hasPendingRequest = false;
	const generator =
		mode === "resume"
			? provider.resumeSession(session, {
					session,
					prompt,
					signal: activeRun.abortController.signal,
			  })
			: provider.sendInput({
					session,
					prompt,
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
				continue;
			}

			const storedEvent = sessionStore.appendEvent(sessionId, event);
			publishEvent(storedEvent);

			if (event.kind === "error") {
				nextStatus = "failed";
			}
		}
	} catch (error) {
		nextStatus = activeRun.abortController.signal.aborted ? "interrupted" : "failed";
		const storedEvent = sessionStore.appendEvent(sessionId, {
			kind: "error",
			summary: "Run failed",
			data: {
				message: error instanceof Error ? error.message : String(error),
			},
			rawProviderEvent: null,
		});
		publishEvent(storedEvent);
	} finally {
		activeRuns.delete(sessionId);

		if (nextStatus === "idle" && hasPendingRequest) {
			nextStatus = "waiting";
		}

		const updatedSession = sessionStore.updateSession(sessionId, {
			status: nextStatus,
			pid: null,
		});

		if (updatedSession) {
			publishSession(updatedSession);
		}

		activeRun.resolveDone();
	}
}

export const sessionBroker = {
	listSessions() {
		return sessionStore.listSessions();
	},
	getSessionDetail(sessionId: string) {
		return sessionStore.getSessionDetail(sessionId);
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

		if (!provider.capabilities().canCreate) {
			throw new Error(`${provider.label} cannot start managed sessions in v1`);
		}

		const session = sessionStore.createSession({
			provider: input.provider,
			cwd: input.cwd,
			title: input.title?.trim() || `${provider.label} session`,
			permissionMode: input.permissionMode ?? "default",
			allowedTools: normalizeAllowedTools(input.allowedTools ?? []),
		});

		if (input.prompt?.trim()) {
			void consumeProviderRun(session.id, input.prompt, "send");
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
			throw new Error("Historical session not found");
		}

		return sessionStore.createSession({
			provider: input.provider,
			cwd: historicalSession.cwd,
			title: historicalSession.title,
			imported: true,
			providerSessionRef: historicalSession.providerSessionRef,
			permissionMode: input.permissionMode ?? "default",
			allowedTools: normalizeAllowedTools(input.allowedTools ?? []),
		});
	},
	async sendInput(sessionId: string, input: SessionInputPayload) {
		if (activeRuns.has(sessionId)) {
			throw new Error("Session already running");
		}

		if (input.prompt.trim().length === 0) {
			throw new Error("Prompt is required");
		}

		void consumeProviderRun(sessionId, input.prompt, "send");

		return sessionStore.getSession(sessionId);
	},
	controlSession(sessionId: string, input: SessionControlPayload) {
		const activeRun = activeRuns.get(sessionId);

		if (!activeRun) {
			throw new Error("Session is not running");
		}

		activeRun.abortController.abort();

		if (input.action === "terminate") {
			return;
		}
	},
	async respondToRequest(requestId: string, input: RequestResponsePayload) {
		const request = sessionStore.getPendingRequest(requestId);

		if (!request || request.status !== "pending") {
			throw new Error("Pending request not found");
		}

		const session = sessionStore.getSession(request.sessionId);

		if (!session) {
			throw new Error(`Unknown session: ${request.sessionId}`);
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
			const updatedSession = sessionStore.updateSession(session.id, { status: "idle" });

			if (updatedSession) {
				publishSession(updatedSession);
			}

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
			throw new Error("toolRule is required to approve this request");
		}

		const allowedTools = normalizeAllowedTools([...session.allowedTools, toolRule]);
		const updatedSession = sessionStore.updateSession(session.id, {
			status: "running",
			allowedTools,
		});

		if (!updatedSession) {
			throw new Error(`Unknown session: ${session.id}`);
		}

		publishSession(updatedSession);

		const resolvedRequest = sessionStore.resolvePendingRequest(requestId, "resolved", {
			...request.data,
			decision: "allow",
			toolRule,
		});
		publishRequest(resolvedRequest);

		if (!updatedSession.providerSessionRef) {
			throw new Error("Session cannot resume without a provider session reference");
		}

		const resumePrompt =
			typeof request.data.resumePrompt === "string" && request.data.resumePrompt.length > 0
				? request.data.resumePrompt
				: "The user approved the blocked request. Retry it if still needed, then continue the task.";

		void consumeProviderRun(updatedSession.id, resumePrompt, "resume");

		return resolvedRequest;
	},
};
