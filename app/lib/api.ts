import type {
	CreateSessionInput,
	HostSession,
	PendingRequest,
	ProviderSummary,
	RequestResponsePayload,
	SessionDetail,
	SessionStreamMessage,
} from "~/lib/shelleport";

const TOKEN_KEY = "shelleport_token";

export function getToken(): string | null {
	if (typeof window === "undefined") return null;
	return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string) {
	localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
	localStorage.removeItem(TOKEN_KEY);
}

function headers(token: string, json = false): HeadersInit {
	const h: Record<string, string> = { Authorization: `Bearer ${token}` };
	if (json) h["Content-Type"] = "application/json";
	return h;
}

async function request<T>(path: string, token: string, init?: RequestInit): Promise<T> {
	const res = await fetch(path, {
		...init,
		headers: { ...headers(token, !!init?.body), ...init?.headers },
	});

	if (res.status === 401) {
		clearToken();
		window.location.href = "/login";
		throw new Error("Unauthorized");
	}

	if (!res.ok) {
		const body = await res.json().catch(() => ({ error: res.statusText }));
		throw new Error(body.error ?? `Request failed: ${res.status}`);
	}

	return res.json() as Promise<T>;
}

export function validateToken(token: string) {
	return request<{ providers: ProviderSummary[] }>("/api/providers", token);
}

export function fetchSessions(token: string) {
	return request<{ sessions: HostSession[] }>("/api/sessions", token);
}

export function fetchSessionDetail(token: string, sessionId: string) {
	return request<SessionDetail>(`/api/sessions/${sessionId}`, token);
}

export function createSession(token: string, input: CreateSessionInput) {
	return request<{ session: HostSession }>("/api/sessions", token, {
		method: "POST",
		body: JSON.stringify(input),
	});
}

export function sendInput(token: string, sessionId: string, prompt: string) {
	return request<{ session: HostSession }>(`/api/sessions/${sessionId}/input`, token, {
		method: "POST",
		body: JSON.stringify({ prompt }),
	});
}

export function controlSession(
	token: string,
	sessionId: string,
	action: "interrupt" | "terminate",
) {
	return request<{ ok: boolean }>(`/api/sessions/${sessionId}/control`, token, {
		method: "POST",
		body: JSON.stringify({ action }),
	});
}

export function respondToRequest(
	token: string,
	requestId: string,
	payload: RequestResponsePayload,
) {
	return request<{ request: PendingRequest }>(`/api/requests/${requestId}/respond`, token, {
		method: "POST",
		body: JSON.stringify(payload),
	});
}

/**
 * Connect to SSE stream for a session. Returns an AbortController to disconnect.
 * AIDEV-NOTE: Uses fetch-based SSE (not EventSource) to support Bearer token auth headers.
 */
export function connectSSE(
	token: string,
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
				headers: headers(token),
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
