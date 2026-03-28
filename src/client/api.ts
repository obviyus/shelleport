import type {
	CreateSessionInput,
	DirectoryListing,
	HostSession,
	PendingRequest,
	ProviderSummary,
	QueuedSessionInput,
	QueuedSessionInputUpdatePayload,
	RequestResponsePayload,
	SessionDetail,
	SessionMetaPayload,
	SessionStreamMessage,
} from "~/shared/shelleport";
import type { AppBootData } from "~/client/boot";

function headers(json = false): HeadersInit {
	const h: Record<string, string> = {};
	if (json) h["Content-Type"] = "application/json";
	return h;
}

function mergeHeaders(json: boolean, initHeaders?: HeadersInit) {
	const merged = new Headers(headers(json));

	if (initHeaders) {
		for (const [key, value] of new Headers(initHeaders).entries()) {
			merged.set(key, value);
		}
	}

	return merged;
}

async function request<T>(
	path: string,
	init?: RequestInit & {
		redirectOnUnauthorized?: boolean;
	},
): Promise<T> {
	const isJsonBody = init?.body !== undefined && !(init.body instanceof FormData);
	const res = await fetch(path, {
		...init,
		credentials: "same-origin",
		headers: mergeHeaders(isJsonBody, init?.headers),
	});

	if (res.status === 401) {
		if (init?.redirectOnUnauthorized !== false) {
			window.location.href = "/login";
		}

		throw new Error("Unauthorized");
	}

	if (!res.ok) {
		const body = await res.json().catch(() => ({ error: res.statusText }));
		throw new Error(body.error ?? `Request failed: ${res.status}`);
	}

	return res.json() as Promise<T>;
}

export function validateSession() {
	return request<{ authenticated: true }>("/api/auth/session", {
		redirectOnUnauthorized: false,
	});
}

export function fetchBootstrap(pathname: string) {
	const params = new URLSearchParams({ pathname });
	return request<{ boot: AppBootData }>(`/api/bootstrap?${params.toString()}`);
}

export function login(token: string) {
	return request<{ authenticated: true }>("/api/auth/session", {
		method: "POST",
		body: JSON.stringify({ token }),
	});
}

export function fetchSessions(query = "") {
	const params = new URLSearchParams();

	if (query.trim().length > 0) {
		params.set("q", query);
	}

	const suffix = params.size > 0 ? `?${params.toString()}` : "";
	return request<{ sessions: HostSession[] }>(`/api/sessions${suffix}`);
}

export function fetchDirectory(path: string) {
	const params = new URLSearchParams({ path });
	return request<DirectoryListing>(`/api/directories?${params.toString()}`);
}

export function fetchSessionDetail(sessionId: string) {
	return request<SessionDetail>(`/api/sessions/${sessionId}`);
}

export function createSession(input: CreateSessionInput) {
	return request<{ session: HostSession }>("/api/sessions", {
		method: "POST",
		body: JSON.stringify(input),
	});
}

export function fetchProviders() {
	return request<{ providers: ProviderSummary[] }>("/api/providers");
}

export function sendInput(sessionId: string, prompt: string, attachments: File[]) {
	const formData = new FormData();
	formData.set("prompt", prompt);

	for (const file of attachments) {
		formData.append("attachments", file);
	}

	return request<{ session: HostSession }>(`/api/sessions/${sessionId}/input`, {
		method: "POST",
		body: formData,
	});
}

export function controlSession(sessionId: string, action: "interrupt" | "terminate") {
	return request<{ ok: boolean }>(`/api/sessions/${sessionId}/control`, {
		method: "POST",
		body: JSON.stringify({ action }),
	});
}

export function deleteSession(sessionId: string) {
	return request<{ session: HostSession }>(`/api/sessions/${sessionId}`, {
		method: "DELETE",
	});
}

export function setSessionArchived(sessionId: string, archived: boolean) {
	return request<{ session: HostSession }>(`/api/sessions/${sessionId}/archive`, {
		method: "POST",
		body: JSON.stringify({ archived }),
	});
}

export function updateSessionMeta(sessionId: string, payload: SessionMetaPayload) {
	return request<{ session: HostSession }>(`/api/sessions/${sessionId}/meta`, {
		method: "POST",
		body: JSON.stringify(payload),
	});
}

export function updateQueuedInput(
	sessionId: string,
	queuedInputId: string,
	payload: QueuedSessionInputUpdatePayload,
) {
	return request<{ queuedInput: QueuedSessionInput }>(
		`/api/sessions/${sessionId}/queued-inputs/${queuedInputId}`,
		{
			method: "PATCH",
			body: JSON.stringify(payload),
		},
	);
}

export function deleteQueuedInput(sessionId: string, queuedInputId: string) {
	return request<{ queuedInput: QueuedSessionInput }>(
		`/api/sessions/${sessionId}/queued-inputs/${queuedInputId}`,
		{
			method: "DELETE",
		},
	);
}

export function respondToRequest(requestId: string, payload: RequestResponsePayload) {
	return request<{ request: PendingRequest }>(`/api/requests/${requestId}/respond`, {
		method: "POST",
		body: JSON.stringify(payload),
	});
}

export function connectSSE(
	sessionId: string,
	onMessage: (msg: SessionStreamMessage) => void,
	onError?: (err: Error) => void,
	onConnectionChange?: (state: "connected" | "reconnecting") => void,
): AbortController {
	const controller = new AbortController();
	let reconnectDelayMs = 1_000;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let staleTimer: ReturnType<typeof setTimeout> | null = null;
	let streamController: AbortController | null = null;

	function clearReconnectTimer() {
		if (reconnectTimer) {
			clearTimeout(reconnectTimer);
			reconnectTimer = null;
		}
	}

	function clearStaleTimer() {
		if (staleTimer) {
			clearTimeout(staleTimer);
			staleTimer = null;
		}
	}

	function resetStaleTimer() {
		clearStaleTimer();
		staleTimer = setTimeout(() => {
			if (!controller.signal.aborted && streamController) {
				streamController.abort(new Error("SSE heartbeat timed out"));
			}
		}, 45000);
	}

	function scheduleReconnect() {
		if (controller.signal.aborted || reconnectTimer) {
			return;
		}

		onConnectionChange?.("reconnecting");

		reconnectTimer = setTimeout(() => {
			reconnectTimer = null;
			void openStream();
		}, reconnectDelayMs);
		reconnectDelayMs = Math.min(reconnectDelayMs * 2, 5000);
	}

	async function openStream() {
		clearReconnectTimer();
		clearStaleTimer();
		streamController = new AbortController();

		try {
			const res = await fetch(`/api/sessions/${sessionId}/events`, {
				credentials: "same-origin",
				signal: streamController.signal,
			});

			if (!res.ok || !res.body) {
				onError?.(new Error(`SSE connection failed: ${res.status}`));
				scheduleReconnect();
				return;
			}

			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			reconnectDelayMs = 1_000;
			resetStaleTimer();
			onConnectionChange?.("connected");

			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					scheduleReconnect();
					break;
				}

				buffer += decoder.decode(value, { stream: true });
				resetStaleTimer();
				const parts = buffer.split("\n\n");
				buffer = parts.pop()!;

				for (const part of parts) {
					for (const line of part.split("\n")) {
						if (line.startsWith("data: ")) {
							try {
								onMessage(JSON.parse(line.slice(6)) as SessionStreamMessage);
							} catch {
								// skip malformed JSON
							}
						}
					}
				}
			}
		} catch (err) {
			if ((err as Error).name === "AbortError") {
				if (!controller.signal.aborted) {
					scheduleReconnect();
				}
			} else {
				onError?.(err as Error);
				scheduleReconnect();
			}
		} finally {
			clearStaleTimer();
			streamController = null;
		}
	}

	controller.signal.addEventListener("abort", () => {
		clearReconnectTimer();
		clearStaleTimer();
		streamController?.abort();
	});

	void openStream();

	return controller;
}
