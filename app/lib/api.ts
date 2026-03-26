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

export function controlSession(token: string, sessionId: string, action: "interrupt" | "terminate") {
	return request<{ ok: boolean }>(`/api/sessions/${sessionId}/control`, token, {
		method: "POST",
		body: JSON.stringify({ action }),
	});
}

export function respondToRequest(token: string, requestId: string, payload: RequestResponsePayload) {
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
): AbortController {
	const controller = new AbortController();

	(async () => {
		try {
			const res = await fetch(`/api/sessions/${sessionId}/events`, {
				headers: headers(token),
				signal: controller.signal,
			});

			if (!res.ok || !res.body) {
				onError?.(new Error(`SSE connection failed: ${res.status}`));
				return;
			}

			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
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
			if ((err as Error).name !== "AbortError") {
				onError?.(err as Error);
			}
		}
	})();

	return controller;
}
