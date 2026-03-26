import { LogOut, Plus, RefreshCw, TerminalSquare } from "lucide-react";
import { startTransition, useEffect, useState } from "react";
import { Form } from "react-router";
import type {
	HistoricalSession,
	HostEvent,
	HostSession,
	ProviderId,
	SessionDetail,
	SessionStreamMessage,
} from "~/lib/shelleport";
import { requireAuth } from "~/server/auth.server";
import { listProviders } from "~/server/providers/registry.server";
import { sessionBroker } from "~/server/session-broker.server";
import type { Route } from "./+types/home";

export async function loader({ request }: Route.LoaderArgs) {
	await requireAuth(request);

	return {
		defaultCwd: process.cwd(),
		sessions: sessionBroker.listSessions(),
		providers: listProviders(),
	};
}

export default function Home({ loaderData }: Route.ComponentProps) {
	const [sessions, setSessions] = useState(loaderData.sessions);
	const [providers] = useState(loaderData.providers);
	const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
		loaderData.sessions[0]?.id ?? null,
	);
	const [selectedDetail, setSelectedDetail] = useState<SessionDetail | null>(null);
	const [historicalProviderId, setHistoricalProviderId] = useState<ProviderId>("claude");
	const [historicalSessions, setHistoricalSessions] = useState<HistoricalSession[]>([]);
	const [newSessionTitle, setNewSessionTitle] = useState("");
	const [newSessionCwd, setNewSessionCwd] = useState(loaderData.defaultCwd);
	const [newSessionProvider, setNewSessionProvider] = useState<ProviderId>("claude");
	const [promptDraft, setPromptDraft] = useState("");
	const [pendingState, setPendingState] = useState<string | null>(null);

	useEffect(() => {
		if (!selectedSessionId) {
			setSelectedDetail(null);
			return;
		}

		let cancelled = false;

		void fetch(`/api/sessions/${selectedSessionId}`)
			.then((response) => response.json())
			.then((detail: SessionDetail) => {
				if (!cancelled) {
					setSelectedDetail(detail);
				}
			});

		const socket = new WebSocket(
			`${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws/sessions/${selectedSessionId}`,
		);

		socket.onmessage = (message) => {
			const payload = JSON.parse(message.data) as SessionStreamMessage;

			startTransition(() => {
				if (payload.type === "snapshot") {
					setSelectedDetail(payload.payload);
					setSessions((currentSessions) =>
						currentSessions.map((session) =>
							session.id === payload.payload.session.id ? payload.payload.session : session,
						),
					);
				}

				if (payload.type === "session") {
					setSessions((currentSessions) =>
						currentSessions.map((session) =>
							session.id === payload.payload.id ? payload.payload : session,
						),
					);
					setSelectedDetail((currentDetail) =>
						currentDetail && currentDetail.session.id === payload.payload.id
							? { ...currentDetail, session: payload.payload }
							: currentDetail,
					);
				}

				if (payload.type === "event") {
					setSelectedDetail((currentDetail) =>
						currentDetail && currentDetail.session.id === payload.payload.sessionId
							? {
									...currentDetail,
									events: [...currentDetail.events, payload.payload],
							  }
							: currentDetail,
					);
				}
			});
		};

		return () => {
			cancelled = true;
			socket.close();
		};
	}, [selectedSessionId]);

	useEffect(() => {
		void fetch(`/api/providers/${historicalProviderId}/sessions`)
			.then((response) => response.json())
			.then((payload: { sessions: HistoricalSession[] }) => {
				setHistoricalSessions(payload.sessions.slice(0, 12));
			});
	}, [historicalProviderId]);

	async function createSession() {
		setPendingState("create");

		const response = await fetch("/api/sessions", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				provider: newSessionProvider,
				cwd: newSessionCwd,
				title: newSessionTitle,
			}),
		});
		const payload = (await response.json()) as { session: HostSession };
		setSessions((currentSessions) => [payload.session, ...currentSessions]);
		setSelectedSessionId(payload.session.id);
		setPromptDraft("");
		setPendingState(null);
	}

	async function importHistoricalSession(provider: ProviderId, providerSessionRef: string) {
		setPendingState("import");
		const response = await fetch("/api/sessions/import", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				provider,
				providerSessionRef,
			}),
		});
		const payload = (await response.json()) as { session: HostSession };
		setSessions((currentSessions) => [payload.session, ...currentSessions]);
		setSelectedSessionId(payload.session.id);
		setPendingState(null);
	}

	async function sendPrompt() {
		if (!selectedSessionId || promptDraft.trim().length === 0) {
			return;
		}

		setPendingState("prompt");
		const prompt = promptDraft;
		setPromptDraft("");
		await fetch(`/api/sessions/${selectedSessionId}/input`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				prompt,
			}),
		});
		setPendingState(null);
	}

	async function interruptSession() {
		if (!selectedSessionId) {
			return;
		}

		await fetch(`/api/sessions/${selectedSessionId}/control`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				action: "interrupt",
			}),
		});
	}

	return (
		<main className="min-h-screen bg-[radial-gradient(circle_at_top_left,rgba(255,196,72,0.25),transparent_25%),radial-gradient(circle_at_top_right,rgba(73,209,255,0.18),transparent_32%),linear-gradient(135deg,#07131a_0%,#10232c_45%,#f3ede2_110%)] px-4 py-4 text-slate-950 lg:px-6">
			<div className="mx-auto grid min-h-[calc(100vh-2rem)] max-w-[1600px] gap-4 rounded-[2rem] border border-white/30 bg-white/70 p-4 shadow-[0_20px_120px_rgba(9,15,22,0.18)] backdrop-blur lg:grid-cols-[320px_minmax(0,1fr)_320px]">
				<aside className="flex min-h-0 flex-col rounded-[1.6rem] bg-slate-950 px-4 py-4 text-white">
					<div className="flex items-start justify-between">
						<div>
							<p className="font-mono text-xs uppercase tracking-[0.35em] text-cyan-200/70">shelleport</p>
							<h1 className="mt-3 text-3xl font-semibold tracking-tight">Agent host</h1>
						</div>
						<Form action="/logout" method="post">
							<button
								className="rounded-full border border-white/15 p-2 text-slate-300 transition hover:border-white/35 hover:text-white"
								type="submit"
							>
								<LogOut className="size-4" />
							</button>
						</Form>
					</div>

					<div className="mt-6 rounded-[1.4rem] border border-white/10 bg-white/5 p-4">
						<div className="flex items-center gap-2 text-sm font-medium text-white">
							<Plus className="size-4" />
							New managed session
						</div>
						<div className="mt-4 space-y-3">
							<select
								className="w-full rounded-2xl border border-white/10 bg-slate-900 px-3 py-2.5 text-sm"
								onChange={(event) => setNewSessionProvider(event.target.value as ProviderId)}
								value={newSessionProvider}
							>
								{providers
									.filter((provider) => provider.capabilities.canCreate)
									.map((provider) => (
										<option key={provider.id} value={provider.id}>
											{provider.label}
										</option>
									))}
							</select>
							<input
								className="w-full rounded-2xl border border-white/10 bg-slate-900 px-3 py-2.5 text-sm placeholder:text-slate-500"
								onChange={(event) => setNewSessionTitle(event.target.value)}
								placeholder="Optional title"
								value={newSessionTitle}
							/>
							<input
								className="w-full rounded-2xl border border-white/10 bg-slate-900 px-3 py-2.5 text-sm placeholder:text-slate-500"
								onChange={(event) => setNewSessionCwd(event.target.value)}
								placeholder="/absolute/path"
								value={newSessionCwd}
							/>
							<button
								className="w-full rounded-2xl bg-cyan-300 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-cyan-200 disabled:bg-cyan-300/50"
								disabled={pendingState === "create"}
								onClick={createSession}
								type="button"
							>
								Create session
							</button>
						</div>
					</div>

					<div className="mt-6 min-h-0 flex-1 overflow-y-auto">
						<div className="mb-3 flex items-center justify-between">
							<h2 className="text-sm font-medium text-slate-300">Managed sessions</h2>
							<span className="font-mono text-xs text-slate-500">{sessions.length}</span>
						</div>
						<div className="space-y-2">
							{sessions.map((session) => (
								<button
									className={`w-full rounded-[1.25rem] border px-4 py-3 text-left transition ${
										selectedSessionId === session.id
											? "border-cyan-300/60 bg-cyan-300/10"
											: "border-white/8 bg-white/4 hover:border-white/18 hover:bg-white/8"
									}`}
									key={session.id}
									onClick={() => setSelectedSessionId(session.id)}
									type="button"
								>
									<div className="flex items-center justify-between gap-3">
										<p className="line-clamp-1 text-sm font-medium text-white">{session.title}</p>
										<span className="rounded-full border border-white/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.2em] text-slate-400">
											{session.status}
										</span>
									</div>
									<p className="mt-2 line-clamp-1 text-xs text-slate-400">{session.cwd}</p>
								</button>
							))}
						</div>
					</div>
				</aside>

				<section className="flex min-h-0 flex-col rounded-[1.6rem] bg-[#f3ede2]">
					<div className="border-b border-slate-200/80 px-6 py-5">
						<div className="flex flex-wrap items-center justify-between gap-4">
							<div>
								<p className="font-mono text-xs uppercase tracking-[0.35em] text-slate-500">
									{selectedDetail?.session.provider ?? "no session"}
								</p>
								<h2 className="mt-2 text-3xl font-semibold tracking-tight">
									{selectedDetail?.session.title ?? "Pick or create a session"}
								</h2>
								<p className="mt-2 text-sm text-slate-500">
									{selectedDetail?.session.cwd ?? "Managed sessions stay on this host."}
								</p>
							</div>

							<div className="flex items-center gap-2">
								<button
									className="rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-400 hover:text-slate-950"
									onClick={interruptSession}
									type="button"
								>
									Interrupt
								</button>
							</div>
						</div>
					</div>

					<div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
						{selectedDetail ? (
							<div className="space-y-4">
								{selectedDetail.events.length === 0 ? (
									<div className="rounded-[1.4rem] border border-dashed border-slate-300 bg-white/60 p-8 text-center text-sm text-slate-500">
										No events yet. Send the first prompt.
									</div>
								) : null}
								{selectedDetail.events.map((event) => (
									<EventCard event={event} key={event.id} />
								))}
							</div>
						) : (
							<div className="grid min-h-full place-items-center text-center text-slate-500">
								<div>
									<TerminalSquare className="mx-auto size-14 text-slate-400" />
									<p className="mt-4 text-lg font-medium text-slate-700">Session canvas</p>
									<p className="mt-2 text-sm">Managed event stream, not a fake terminal.</p>
								</div>
							</div>
						)}
					</div>

					<div className="border-t border-slate-200/80 px-6 py-5">
						<div className="rounded-[1.6rem] bg-slate-950 p-4 text-white shadow-[0_25px_80px_rgba(0,0,0,0.18)]">
							<textarea
								className="min-h-32 w-full resize-none bg-transparent text-sm leading-6 text-white outline-none placeholder:text-slate-500"
								onChange={(event) => setPromptDraft(event.target.value)}
								placeholder="Tell the agent what to do on this machine."
								value={promptDraft}
							/>
							<div className="mt-4 flex items-center justify-between gap-3">
								<p className="text-xs text-slate-400">
									Claude v1 uses structured CLI events. Codex live control lands next.
								</p>
								<button
									className="rounded-full bg-cyan-300 px-5 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-200 disabled:bg-cyan-300/50"
									disabled={!selectedSessionId || pendingState === "prompt"}
									onClick={sendPrompt}
									type="button"
								>
									Send prompt
								</button>
							</div>
						</div>
					</div>
				</section>

				<aside className="flex min-h-0 flex-col rounded-[1.6rem] bg-white/75 px-4 py-4">
					<div className="rounded-[1.4rem] border border-slate-200 bg-white p-4">
						<div className="flex items-center justify-between">
							<h3 className="text-sm font-semibold text-slate-900">Providers</h3>
							<RefreshCw className="size-4 text-slate-400" />
						</div>
						<div className="mt-4 space-y-3">
							{providers.map((provider) => (
								<div className="rounded-[1.1rem] border border-slate-200 p-3" key={provider.id}>
									<div className="flex items-center justify-between">
										<p className="text-sm font-medium text-slate-900">{provider.label}</p>
										<span className="font-mono text-[10px] uppercase tracking-[0.25em] text-slate-500">
											{provider.status}
										</span>
									</div>
									<p className="mt-2 text-xs text-slate-500">
										live resume {provider.capabilities.liveResume}
									</p>
								</div>
							))}
						</div>
					</div>

					<div className="mt-4 min-h-0 flex-1 overflow-y-auto rounded-[1.4rem] border border-slate-200 bg-white p-4">
						<div className="flex items-center justify-between">
							<h3 className="text-sm font-semibold text-slate-900">Historical sessions</h3>
							<select
								className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600"
								onChange={(event) => setHistoricalProviderId(event.target.value as ProviderId)}
								value={historicalProviderId}
							>
								{providers
									.filter((provider) => provider.capabilities.canResumeHistorical)
									.map((provider) => (
										<option key={provider.id} value={provider.id}>
											{provider.label}
										</option>
									))}
							</select>
						</div>
						<div className="mt-4 space-y-3">
							{historicalSessions.map((session) => (
								<div className="rounded-[1.15rem] border border-slate-200 p-3" key={session.sourcePath}>
									<p className="line-clamp-2 text-sm font-medium text-slate-900">{session.title}</p>
									<p className="mt-2 line-clamp-1 text-xs text-slate-500">{session.cwd}</p>
									<p className="mt-2 line-clamp-3 text-xs leading-5 text-slate-500">
										{session.preview || session.providerSessionRef}
									</p>
									<button
										className="mt-3 rounded-full border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-800 transition hover:border-slate-500"
										onClick={() => importHistoricalSession(session.provider, session.providerSessionRef)}
										type="button"
									>
										Import into shelleport
									</button>
								</div>
							))}
						</div>
					</div>
				</aside>
			</div>
		</main>
	);
}

function EventCard({ event }: { event: HostEvent }) {
	if (event.kind === "text") {
		return (
			<div className="rounded-[1.4rem] bg-white p-5 shadow-[0_10px_40px_rgba(15,23,42,0.06)]">
				<p className="font-mono text-[11px] uppercase tracking-[0.35em] text-slate-400">assistant</p>
				<p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-slate-800">
					{typeof event.data.text === "string" ? event.data.text : event.summary}
				</p>
			</div>
		);
	}

	return (
		<div className="rounded-[1.4rem] border border-slate-200 bg-white/70 p-5">
			<p className="font-mono text-[11px] uppercase tracking-[0.35em] text-slate-400">{event.kind}</p>
			<p className="mt-3 text-sm font-medium text-slate-900">{event.summary}</p>
			<pre className="mt-3 overflow-x-auto rounded-2xl bg-slate-950 px-4 py-3 text-xs leading-6 text-slate-200">
				{JSON.stringify(event.data, null, 2)}
			</pre>
		</div>
	);
}
