import {
	ChevronRight,
	CircleStop,
	FolderOpen,
	Loader2,
	LogOut,
	Plus,
	Send,
	Terminal,
} from "lucide-react";
import { startTransition, useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "~/components/ui/dialog";
import {
	clearToken,
	connectSSE,
	controlSession,
	createSession,
	fetchSessions,
	getToken,
	respondToRequest,
	sendInput,
} from "~/lib/api";
import type {
	HostEvent,
	HostSession,
	PendingRequest,
	RequestResponsePayload,
	SessionStatus,
} from "~/lib/shelleport";
import type { Route } from "./+types/home";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Client-side user message injected into the event stream */
type UserMessage = {
	id: string;
	kind: "user-message";
	text: string;
	createTime: number;
};

/** Union of server events and client-side user messages */
type StreamEntry = HostEvent | UserMessage;

function isUserMessage(entry: StreamEntry): entry is UserMessage {
	return "kind" in entry && entry.kind === "user-message";
}

let userMsgCounter = 0;
function createUserMessage(text: string): UserMessage {
	return {
		id: `user-msg-${++userMsgCounter}`,
		kind: "user-message",
		text,
		createTime: Date.now(),
	};
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader() {
	return { defaultCwd: process.cwd() };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getToolPreview(event: HostEvent): string {
	const input = event.data.input as Record<string, unknown> | undefined;
	if (!input) return event.summary;
	const tool = event.data.toolName as string;
	switch (tool) {
		case "Read":
		case "Write":
		case "Edit":
			return (input.file_path as string) ?? event.summary;
		case "Bash":
			return ((input.command as string) ?? "").slice(0, 100) || event.summary;
		case "Grep":
			return `/${input.pattern}/${input.path ? ` ${input.path}` : ""}`;
		case "Glob":
			return (input.pattern as string) ?? event.summary;
		case "Agent":
			return (input.description as string) ?? event.summary;
		default:
			return event.summary;
	}
}

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n… (${text.length - max} more chars)`;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

const STATUS_STYLES: Record<SessionStatus, string> = {
	idle: "bg-foreground/20",
	running: "bg-foreground animate-status-pulse",
	waiting: "bg-foreground/50 animate-status-pulse",
	failed: "bg-foreground/40",
	interrupted: "bg-foreground/30",
};

function StatusDot({ status }: { status: SessionStatus }) {
	return (
		<span
			className={`inline-block size-1.5 shrink-0 rounded-full ${STATUS_STYLES[status]}`}
			title={status}
		/>
	);
}

// ---------------------------------------------------------------------------
// Event renderer
// ---------------------------------------------------------------------------

function UserMessageRenderer({ message }: { message: UserMessage }) {
	return (
		<div className="animate-event-enter my-3 flex justify-end">
			<div className="max-w-[80%] rounded-md border border-foreground/8 bg-accent px-3 py-2">
				<p className="whitespace-pre-wrap text-xs leading-[1.7] text-foreground/80">
					{message.text}
				</p>
			</div>
		</div>
	);
}

function StreamEntryRenderer({ entry }: { entry: StreamEntry }) {
	if (isUserMessage(entry)) {
		return <UserMessageRenderer message={entry} />;
	}
	return <EventRenderer event={entry} />;
}

function EventRenderer({ event }: { event: HostEvent }) {
	if (event.kind === "text") {
		return (
			<div className="animate-event-enter py-2">
				<p className="whitespace-pre-wrap text-xs leading-[1.8] text-foreground/85">
					{typeof event.data.text === "string" ? event.data.text : event.summary}
				</p>
			</div>
		);
	}

	if (event.kind === "tool-call") {
		return (
			<div className="animate-event-enter my-1.5 rounded border border-border bg-card px-3 py-2">
				<span className="text-[11px] font-semibold text-foreground/70">
					{event.data.toolName as string}
				</span>
				<p className="mt-0.5 truncate text-[11px] text-muted-foreground">
					{getToolPreview(event)}
				</p>
			</div>
		);
	}

	if (event.kind === "tool-result") {
		const content = (event.data.content as string) ?? "";
		const isError = event.data.isError === true;
		return (
			<div className="animate-event-enter my-0.5 ml-3">
				<details className="group">
					<summary className="flex cursor-pointer items-center gap-1 text-[11px] text-muted-foreground transition hover:text-foreground/60">
						<ChevronRight className="size-2.5 transition-transform group-open:rotate-90" />
						Result
						{isError && <span className="text-destructive">(error)</span>}
					</summary>
					<pre className="mt-1 max-h-56 overflow-auto rounded border border-border bg-muted/50 p-2 text-[10px] leading-relaxed text-foreground/60">
						{truncate(content, 5000)}
					</pre>
				</details>
			</div>
		);
	}

	if (event.kind === "error") {
		const message =
			typeof event.data.message === "string"
				? event.data.message
				: typeof event.data.stderr === "string"
					? event.data.stderr
					: event.summary;
		return (
			<div className="animate-event-enter my-2 rounded border border-destructive/20 bg-destructive/5 px-3 py-2">
				<p className="text-[11px] font-medium text-destructive">{event.summary}</p>
				{message !== event.summary && (
					<p className="mt-1 text-[10px] text-destructive/60">{message}</p>
				)}
			</div>
		);
	}

	// system / state
	return (
		<div className="animate-event-enter my-3 flex items-center gap-3 text-[10px] text-muted-foreground/40">
			<div className="h-px flex-1 bg-border" />
			<span className="shrink-0">{event.summary}</span>
			<div className="h-px flex-1 bg-border" />
		</div>
	);
}

// ---------------------------------------------------------------------------
// Pending request banner
// ---------------------------------------------------------------------------

function PendingRequestBanner({
	request,
	onRespond,
}: {
	request: PendingRequest;
	onRespond: (id: string, payload: RequestResponsePayload) => void;
}) {
	return (
		<div className="border-t border-border bg-accent px-5 py-3">
			<div className="mx-auto flex max-w-3xl items-center justify-between gap-4">
				<span className="min-w-0 truncate text-xs text-foreground/80">
					{request.prompt}
				</span>
				<div className="flex shrink-0 gap-2">
					<button
						type="button"
						onClick={() => onRespond(request.id, { decision: "allow" })}
						className="rounded border border-foreground/20 bg-foreground px-3 py-1 text-[11px] font-medium text-background transition hover:bg-foreground/90"
					>
						Allow
					</button>
					<button
						type="button"
						onClick={() => onRespond(request.id, { decision: "deny" })}
						className="rounded border border-border px-3 py-1 text-[11px] font-medium text-muted-foreground transition hover:text-foreground"
					>
						Deny
					</button>
				</div>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyState({ onNew }: { onNew: () => void }) {
	return (
		<div className="flex flex-1 items-center justify-center">
			<div className="text-center">
				<div className="mx-auto mb-6 flex size-14 items-center justify-center rounded-lg border border-border bg-card">
					<Terminal className="size-6 text-muted-foreground/40" />
				</div>
				<p className="text-xs font-medium text-foreground/60">No session selected</p>
				<p className="mt-1.5 text-[11px] text-muted-foreground">
					Create a session to start
				</p>
				<button
					type="button"
					onClick={onNew}
					className="mt-6 inline-flex items-center gap-1.5 rounded-md bg-foreground px-4 py-2 text-xs font-medium text-background transition hover:bg-foreground/90"
				>
					<Plus className="size-3.5" />
					New session
				</button>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function Home({ loaderData }: Route.ComponentProps) {
	const navigate = useNavigate();
	const scrollRef = useRef<HTMLDivElement>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const isAtBottom = useRef(true);

	const [token] = useState(() => getToken());
	const [sessions, setSessions] = useState<HostSession[]>([]);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [session, setSession] = useState<HostSession | null>(null);
	const [stream, setStream] = useState<StreamEntry[]>([]);
	const [pendingRequests, setPendingRequests] = useState<PendingRequest[]>([]);
	const [prompt, setPrompt] = useState("");
	const [showNewSession, setShowNewSession] = useState(false);
	const [newCwd, setNewCwd] = useState(loaderData.defaultCwd);
	const [newTitle, setNewTitle] = useState("");
	const [isCreating, setIsCreating] = useState(false);
	const [initialLoading, setInitialLoading] = useState(true);

	// Auth guard
	useEffect(() => {
		if (!token) navigate("/login", { replace: true });
	}, [token, navigate]);

	// Fetch sessions
	useEffect(() => {
		if (!token) return;
		fetchSessions(token)
			.then(({ sessions: s }) => {
				setSessions(s);
				setInitialLoading(false);
			})
			.catch(() => setInitialLoading(false));
	}, [token]);

	// SSE
	useEffect(() => {
		if (!selectedId || !token) return;

		setStream([]);
		setPendingRequests([]);
		setSession(null);

		const controller = connectSSE(
			token,
			selectedId,
			(msg) => {
				startTransition(() => {
					if (msg.type === "snapshot") {
						setSession(msg.payload.session);
						setStream(msg.payload.events);
						setPendingRequests(
							msg.payload.pendingRequests.filter((r) => r.status === "pending"),
						);
						setSessions((prev) =>
							prev.map((s) =>
								s.id === msg.payload.session.id ? msg.payload.session : s,
							),
						);
					} else if (msg.type === "session") {
						setSession(msg.payload);
						setSessions((prev) =>
							prev.map((s) => (s.id === msg.payload.id ? msg.payload : s)),
						);
					} else if (msg.type === "event") {
						setStream((prev) => [...prev, msg.payload]);
					} else if (msg.type === "request") {
						setPendingRequests((prev) =>
							msg.payload.status === "pending"
								? [...prev.filter((r) => r.id !== msg.payload.id), msg.payload]
								: prev.filter((r) => r.id !== msg.payload.id),
						);
					}
				});
			},
			(err) => console.error("SSE error:", err),
		);

		return () => controller.abort();
	}, [selectedId, token]);

	// Auto-scroll
	useEffect(() => {
		if (isAtBottom.current && scrollRef.current) {
			scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
		}
	}, [stream]);

	function handleScroll() {
		const el = scrollRef.current;
		if (!el) return;
		isAtBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
	}

	// Actions
	const handleCreateSession = useCallback(async () => {
		if (!token || !newCwd.trim()) return;
		setIsCreating(true);
		try {
			const result = await createSession(token, {
				provider: "claude",
				cwd: newCwd.trim(),
				title: newTitle.trim() || undefined,
			});
			setSessions((prev) => [result.session, ...prev]);
			setSelectedId(result.session.id);
			setShowNewSession(false);
			setNewTitle("");
			setTimeout(() => textareaRef.current?.focus(), 100);
		} catch (err) {
			console.error("Failed to create session:", err);
		} finally {
			setIsCreating(false);
		}
	}, [token, newCwd, newTitle]);

	const handleSend = useCallback(async () => {
		if (!token || !selectedId || !prompt.trim() || session?.status === "running") return;
		const text = prompt;
		setPrompt("");
		if (textareaRef.current) textareaRef.current.style.height = "auto";

		// Inject user message into the stream immediately
		setStream((prev) => [...prev, createUserMessage(text)]);

		try {
			await sendInput(token, selectedId, text);
		} catch {
			setPrompt(text);
		}
	}, [token, selectedId, prompt, session?.status]);

	const handleInterrupt = useCallback(async () => {
		if (!token || !selectedId) return;
		try {
			await controlSession(token, selectedId, "interrupt");
		} catch {
			/* ignore */
		}
	}, [token, selectedId]);

	const handleRespond = useCallback(
		async (requestId: string, payload: RequestResponsePayload) => {
			if (!token) return;
			try {
				await respondToRequest(token, requestId, payload);
			} catch (err) {
				console.error("Failed to respond:", err);
			}
		},
		[token],
	);

	function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			handleSend();
		}
	}

	function autoResize(el: HTMLTextAreaElement) {
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
	}

	function handleLogout() {
		clearToken();
		navigate("/login", { replace: true });
	}

	if (!token) return null;

	const canSend = !!selectedId && prompt.trim().length > 0 && session?.status !== "running";

	return (
		<div className="flex h-screen overflow-hidden bg-background">
			{/* ============================================================= */}
			{/* Sidebar                                                        */}
			{/* ============================================================= */}
			<aside className="flex w-56 shrink-0 flex-col border-r border-border bg-card/50">
				{/* Header */}
				<div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
					<span className="text-[11px] font-semibold uppercase tracking-[0.15em] text-foreground/60">
						shelleport
					</span>
					<button
						type="button"
						onClick={() => setShowNewSession(true)}
						className="flex size-6 items-center justify-center rounded text-muted-foreground transition hover:bg-accent hover:text-foreground"
						title="New session"
					>
						<Plus className="size-3.5" />
					</button>
				</div>

				{/* Sessions */}
				<div className="flex-1 overflow-y-auto px-2 py-2">
					{initialLoading ? (
						<div className="flex items-center justify-center py-8">
							<Loader2 className="size-3.5 animate-spin text-muted-foreground" />
						</div>
					) : sessions.length === 0 ? (
						<div className="py-8 text-center">
							<p className="text-[11px] text-muted-foreground">No sessions</p>
							<button
								type="button"
								onClick={() => setShowNewSession(true)}
								className="mt-2 text-[11px] text-foreground/50 transition hover:text-foreground"
							>
								Create one
							</button>
						</div>
					) : (
						<div className="space-y-px">
							{sessions.map((s) => (
								<button
									key={s.id}
									type="button"
									onClick={() => setSelectedId(s.id)}
									className={`group w-full rounded-md px-2.5 py-2 text-left transition ${
										selectedId === s.id
											? "bg-accent text-foreground"
											: "text-foreground/60 hover:bg-accent/50 hover:text-foreground/80"
									}`}
								>
									<div className="flex items-center gap-2">
										<StatusDot status={s.status} />
										<span className="line-clamp-1 text-xs">
											{s.title}
										</span>
									</div>
									<p className="mt-0.5 ml-3.5 truncate text-[10px] text-muted-foreground">
										{s.cwd.split("/").slice(-2).join("/")}
									</p>
								</button>
							))}
						</div>
					)}
				</div>

				{/* Footer */}
				<div className="shrink-0 border-t border-border px-2 py-2">
					<button
						type="button"
						onClick={handleLogout}
						className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-[11px] text-muted-foreground transition hover:bg-accent hover:text-foreground"
					>
						<LogOut className="size-3" />
						Disconnect
					</button>
				</div>
			</aside>

			{/* ============================================================= */}
			{/* Main                                                           */}
			{/* ============================================================= */}
			<main className="flex flex-1 flex-col overflow-hidden">
				{selectedId && session ? (
					<>
						{/* Header */}
						<header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-5">
							<div className="min-w-0">
								<div className="flex items-center gap-2">
									<h1 className="truncate text-xs font-medium text-foreground">
										{session.title}
									</h1>
									<span className="shrink-0 text-[10px] text-muted-foreground">
										{session.cwd}
									</span>
								</div>
							</div>
							<div className="flex shrink-0 items-center gap-3">
								<div className="flex items-center gap-1.5">
									<StatusDot status={session.status} />
									<span className="text-[10px] text-muted-foreground">
										{session.status}
									</span>
								</div>
								{session.status === "running" && (
									<button
										type="button"
										onClick={handleInterrupt}
										className="flex items-center gap-1.5 rounded border border-border px-2 py-1 text-[11px] text-muted-foreground transition hover:border-foreground/20 hover:text-foreground"
									>
										<CircleStop className="size-3" />
										Stop
									</button>
								)}
							</div>
						</header>

						{/* Events */}
						<div
							ref={scrollRef}
							onScroll={handleScroll}
							className="flex-1 overflow-y-auto px-5 py-4"
						>
							{stream.length === 0 && session.status !== "running" ? (
								<div className="flex h-full items-center justify-center">
									<p className="text-xs text-muted-foreground/40">
										Send a message to start
									</p>
								</div>
							) : (
								<div className="mx-auto max-w-3xl">
									{stream.map((entry) => (
										<StreamEntryRenderer key={entry.id} entry={entry} />
									))}
									{session.status === "running" && (
										<div className="animate-thinking mt-1 flex gap-1 py-2">
											<span className="size-1 rounded-full bg-foreground" />
											<span className="size-1 rounded-full bg-foreground" />
											<span className="size-1 rounded-full bg-foreground" />
										</div>
									)}
								</div>
							)}
						</div>

						{/* Pending requests */}
						{pendingRequests.length > 0 && (
							<PendingRequestBanner
								request={pendingRequests[0]}
								onRespond={handleRespond}
							/>
						)}

						{/* Input */}
						<div className="shrink-0 border-t border-border px-5 py-3">
							<div className="mx-auto max-w-3xl">
								<div className="relative rounded-md border border-border bg-card transition-colors focus-within:border-foreground/15">
									<textarea
										ref={textareaRef}
										rows={1}
										value={prompt}
										onChange={(e) => {
											setPrompt(e.target.value);
											autoResize(e.currentTarget);
										}}
										onKeyDown={handleKeyDown}
										placeholder={
											session.status === "running"
												? "Claude is working..."
												: "Message Claude... (Enter to send)"
										}
										disabled={session.status === "running"}
										className="w-full resize-none bg-transparent px-3 py-2.5 pr-10 text-xs text-foreground outline-none placeholder:text-muted-foreground/40 disabled:cursor-not-allowed disabled:opacity-40"
									/>
									<button
										type="button"
										onClick={handleSend}
										disabled={!canSend}
										className="absolute right-2 bottom-2 flex size-7 items-center justify-center rounded bg-foreground text-background transition hover:bg-foreground/85 disabled:opacity-15"
									>
										<Send className="size-3.5" />
									</button>
								</div>
							</div>
						</div>
					</>
				) : (
					<EmptyState onNew={() => setShowNewSession(true)} />
				)}
			</main>

			{/* ============================================================= */}
			{/* New session dialog                                             */}
			{/* ============================================================= */}
			<Dialog open={showNewSession} onOpenChange={setShowNewSession}>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle className="text-sm">New Session</DialogTitle>
						<DialogDescription className="text-xs">
							Start a Claude Code session on the remote machine.
						</DialogDescription>
					</DialogHeader>
					<div className="space-y-4 py-1">
						<div>
							<label className="mb-1.5 block text-[11px] text-muted-foreground">
								Directory
							</label>
							<div className="relative">
								<FolderOpen className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
								<input
									type="text"
									value={newCwd}
									onChange={(e) => setNewCwd(e.target.value)}
									placeholder="/path/to/project"
									className="h-9 w-full rounded-md border border-border bg-background pl-8 pr-3 text-xs text-foreground outline-none transition placeholder:text-muted-foreground/40 focus:border-foreground/15 focus:ring-1 focus:ring-foreground/10"
								/>
							</div>
						</div>
						<div>
							<label className="mb-1.5 block text-[11px] text-muted-foreground">
								Title{" "}
								<span className="text-muted-foreground/40">(optional)</span>
							</label>
							<input
								type="text"
								value={newTitle}
								onChange={(e) => setNewTitle(e.target.value)}
								placeholder="My project"
								className="h-9 w-full rounded-md border border-border bg-background px-3 text-xs text-foreground outline-none transition placeholder:text-muted-foreground/40 focus:border-foreground/15 focus:ring-1 focus:ring-foreground/10"
							/>
						</div>
					</div>
					<DialogFooter>
						<button
							type="button"
							onClick={() => setShowNewSession(false)}
							className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground transition hover:bg-accent hover:text-foreground"
						>
							Cancel
						</button>
						<button
							type="button"
							onClick={handleCreateSession}
							disabled={isCreating || !newCwd.trim()}
							className="flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background transition hover:bg-foreground/90 disabled:opacity-30"
						>
							{isCreating && <Loader2 className="size-3 animate-spin" />}
							Create
						</button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
