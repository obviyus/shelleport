import {
	Archive,
	ArchiveRestore,
	Check,
	ChevronRight,
	CircleStop,
	CircleX,
	FolderOpen,
	ImagePlus,
	Loader2,
	LogOut,
	Plus,
	Send,
	Terminal,
	X,
} from "lucide-react";
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
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
	fetchProviders,
	fetchSessions,
	getToken,
	respondToRequest,
	sendInput,
	setSessionArchived,
} from "~/lib/api";
import type {
	HostEvent,
	HostSession,
	PendingRequest,
	ProviderSummary,
	RequestResponsePayload,
	SessionAttachment,
	SessionStatus,
} from "~/lib/shelleport";
import type { Route } from "./+types/home";

type ImagePreview = {
	name: string;
	url: string;
};

type DraftImage = ImagePreview & {
	file: File;
};

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

function replaceImageExtension(name: string) {
	return name.replace(/\.[A-Za-z0-9]+$/, "") || "image";
}

async function normalizeDraftImage(file: File) {
	const objectUrl = URL.createObjectURL(file);

	try {
		const image = await new Promise<HTMLImageElement>((resolve, reject) => {
			const element = new Image();
			element.onload = () => resolve(element);
			element.onerror = () => reject(new Error("Could not process image"));
			element.src = objectUrl;
		});
		const canvas = document.createElement("canvas");
		canvas.width = image.naturalWidth;
		canvas.height = image.naturalHeight;
		const context = canvas.getContext("2d");

		if (!context) {
			throw new Error("Could not process image");
		}

		context.drawImage(image, 0, 0);

		const blob = await new Promise<Blob>((resolve, reject) => {
			canvas.toBlob((nextBlob) => {
				if (!nextBlob) {
					reject(new Error("Could not process image"));
					return;
				}

				resolve(nextBlob);
			}, "image/png");
		});

		const normalizedName = `${replaceImageExtension(file.name)}.png`;
		const normalizedFile = new File([blob], normalizedName, {
			type: "image/png",
			lastModified: Date.now(),
		});

		return {
			file: normalizedFile,
			name: normalizedFile.name,
			url: URL.createObjectURL(normalizedFile),
		};
	} finally {
		URL.revokeObjectURL(objectUrl);
	}
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

const STATUS_STYLES: Record<SessionStatus, string> = {
	idle: "bg-foreground/20",
	running: "bg-foreground animate-status-pulse",
	waiting: "bg-foreground/50 animate-status-pulse",
	retrying: "bg-amber-500 animate-status-pulse",
	failed: "bg-foreground/40",
	interrupted: "bg-foreground/30",
};

function formatStatus(session: HostSession, now: number) {
	if (session.status === "retrying") {
		const seconds =
			session.statusDetail.nextRetryTime === null
				? null
				: Math.max(0, Math.ceil((session.statusDetail.nextRetryTime - now) / 1000));
		return seconds === null ? "retrying" : `retrying in ${seconds}s`;
	}

	if (session.status === "waiting") {
		return session.statusDetail.waitKind === "approval" ? "waiting approval" : "waiting";
	}

	return session.status;
}

function getStatusMessage(session: HostSession) {
	if (session.status === "retrying") {
		return session.statusDetail.message;
	}

	if (session.status === "waiting") {
		return session.statusDetail.waitKind === "approval"
			? "Waiting for approval."
			: session.statusDetail.waitKind === "question"
				? "Waiting for input."
				: null;
	}

	if (session.status === "failed") {
		return session.statusDetail.message;
	}

	return null;
}

function getSidebarMeta(session: HostSession, now: number) {
	if (session.status === "failed") {
		return "Failed";
	}

	if (session.status === "interrupted") {
		return "Interrupted";
	}

	if (session.status === "retrying") {
		const seconds =
			session.statusDetail.nextRetryTime === null
				? null
				: Math.max(0, Math.ceil((session.statusDetail.nextRetryTime - now) / 1000));
		return seconds === null ? "Retrying" : `Retry in ${seconds}s`;
	}

	if (session.status === "waiting") {
		return session.statusDetail.waitKind === "approval" ? "Waiting approval" : "Waiting";
	}

	return session.cwd.split("/").slice(-2).join("/");
}

function getSidebarTitle(session: HostSession) {
	if (session.status === "failed" && session.statusDetail.message) {
		return session.statusDetail.message;
	}

	return session.cwd;
}

function StatusDot({ status }: { status: SessionStatus }) {
	return (
		<span
			className={`inline-block size-1.5 shrink-0 rounded-full ${STATUS_STYLES[status]}`}
			title={status}
		/>
	);
}

// ---------------------------------------------------------------------------
// Stream grouping — pairs tool-calls with their results
// ---------------------------------------------------------------------------

type ToolGroup = { type: "tool"; call: HostEvent; result: HostEvent | null };
type PassthroughGroup = { type: "entry"; entry: HostEvent };
type GroupedEntry = ToolGroup | PassthroughGroup;

function groupStream(entries: HostEvent[]): GroupedEntry[] {
	const resultMap = new Map<string, HostEvent>();
	for (const e of entries) {
		if (e.kind === "tool-result" && typeof e.data.toolUseId === "string") {
			resultMap.set(e.data.toolUseId, e);
		}
	}

	const consumedIds = new Set<string>();
	const grouped: GroupedEntry[] = [];

	for (const entry of entries) {
		if (entry.kind === "tool-call") {
			const uid = entry.data.toolUseId as string | null;
			const result = uid ? (resultMap.get(uid) ?? null) : null;
			if (result) consumedIds.add(result.id);
			grouped.push({ type: "tool", call: entry, result });
			continue;
		}

		if (entry.kind === "tool-result" && consumedIds.has(entry.id)) {
			continue; // already consumed by its tool-call group
		}

		grouped.push({ type: "entry", entry });
	}

	return grouped;
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

function GroupedEntryRenderer({ group }: { group: GroupedEntry }) {
	if (group.type === "tool") {
		return <ToolCard call={group.call} result={group.result} />;
	}
	return <EventRenderer event={group.entry} />;
}

function UserMessageRenderer({
	text,
	attachments,
}: {
	text: string;
	attachments: Array<ImagePreview | SessionAttachment>;
}) {
	return (
		<div className="animate-event-enter my-3 flex justify-end">
			<div className="max-w-[80%] rounded-md border border-foreground/12 bg-accent/80 px-3 py-2">
				{attachments.length > 0 && (
					<div className="mb-2 flex flex-wrap justify-end gap-2">
						{attachments.map((attachment) => (
							"url" in attachment ? (
								<div
									key={attachment.url}
									className="overflow-hidden rounded-md border border-foreground/10 bg-background/70"
								>
									<img
										src={attachment.url}
										alt={attachment.name}
										className="h-20 w-20 object-cover"
									/>
								</div>
							) : (
								<div
									key={attachment.path}
									className="rounded-md border border-foreground/10 bg-background/70 px-2 py-1 text-[10px] text-foreground/78"
								>
									{attachment.name}
								</div>
							)
						))}
					</div>
				)}
				{text.length > 0 && (
					<p className="whitespace-pre-wrap text-xs leading-[1.7] text-foreground/88">
						{text}
					</p>
				)}
			</div>
		</div>
	);
}

/** Paired tool-call + result card */
function ToolCard({ call, result }: { call: HostEvent; result: HostEvent | null }) {
	const [open, setOpen] = useState(false);
	const toolName = call.data.toolName as string;
	const preview = getToolPreview(call);
	const content = result ? ((result.data.content as string) ?? "") : null;
	const isError = result?.data.isError === true;
	const pending = !result;

	return (
		<div className="animate-event-enter my-1.5 overflow-hidden rounded-md border border-foreground/10 bg-card/90 shadow-[inset_0_1px_0_oklch(1_0_0_/_0.03)]">
			{/* Header — always visible */}
			<button
				type="button"
				onClick={() => content && setOpen((v) => !v)}
				className={`flex w-full items-center gap-2 px-3 py-2 text-left transition ${
					content ? "cursor-pointer hover:bg-accent/70" : "cursor-default"
				}`}
			>
				{/* Expand chevron */}
				{content ? (
					<ChevronRight
						className={`size-3 shrink-0 text-muted-foreground transition-transform ${
							open ? "rotate-90" : ""
						}`}
					/>
				) : (
					<Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground/50" />
				)}

				{/* Tool name badge */}
				<span className="shrink-0 rounded border border-foreground/10 bg-foreground/6 px-1.5 py-px text-[10px] font-medium text-foreground/72">
					{toolName}
				</span>

				{/* Preview */}
				<span className="min-w-0 flex-1 truncate text-[11px] text-foreground/56">{preview}</span>

				{/* Status indicator */}
				{result && !isError && <Check className="size-3 shrink-0 text-foreground/40" />}
				{isError && <X className="size-3 shrink-0 text-destructive/60" />}
				{pending && <span className="shrink-0 text-[10px] text-muted-foreground/70">running</span>}
			</button>

			{/* Expanded result */}
			{open && content && (
				<div className="border-t border-border">
					<pre className="max-h-72 overflow-auto px-3 py-2.5 text-[10px] leading-[1.7] text-foreground/68">
						{truncate(content, 8000)}
					</pre>
				</div>
			)}
		</div>
	);
}

function EventRenderer({ event }: { event: HostEvent }) {
	if (event.kind === "text") {
		if (event.data.role === "user") {
			return (
				<UserMessageRenderer
					text={typeof event.data.text === "string" ? event.data.text : event.summary}
					attachments={
						Array.isArray(event.data.attachments)
							? (event.data.attachments as SessionAttachment[])
							: []
					}
				/>
			);
		}

		return (
			<div className="animate-event-enter py-2">
				<p className="whitespace-pre-wrap text-xs leading-[1.8] text-foreground/85">
					{typeof event.data.text === "string" ? event.data.text : event.summary}
				</p>
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
			<div className="animate-event-enter my-2 rounded-md border border-destructive/30 bg-destructive/8 px-3 py-2">
				<p className="text-[11px] font-medium text-destructive">{event.summary}</p>
				{message !== event.summary && (
					<p className="mt-1 text-[10px] text-destructive/75">{message}</p>
				)}
			</div>
		);
	}

	// system / state / orphan tool-result
	return (
		<div className="animate-event-enter my-3 flex items-center gap-3 text-[10px] text-muted-foreground/72">
			<div className="h-px flex-1 bg-foreground/10" />
			<span className="shrink-0">{event.summary}</span>
			<div className="h-px flex-1 bg-foreground/10" />
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
		<div className="border-t border-foreground/10 bg-accent/80 px-5 py-3">
			<div className="mx-auto flex max-w-3xl items-center justify-between gap-4">
				<span className="min-w-0 truncate text-xs text-foreground/88">{request.prompt}</span>
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
						className="rounded border border-border px-3 py-1 text-[11px] font-medium text-muted-foreground transition hover:border-foreground/16 hover:text-foreground"
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
				<div className="mx-auto mb-6 flex size-14 items-center justify-center rounded-lg border border-foreground/10 bg-card shadow-[inset_0_1px_0_oklch(1_0_0_/_0.03)]">
					<Terminal className="size-6 text-muted-foreground/70" />
				</div>
				<p className="text-xs font-medium text-foreground/72">No session selected</p>
				<p className="mt-1.5 text-[11px] text-muted-foreground/85">Create a session to start</p>
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
	const location = useLocation();
	const { sessionId: selectedId } = useParams();
	const scrollRef = useRef<HTMLDivElement>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const draftImagesRef = useRef<DraftImage[]>([]);
	const isAtBottom = useRef(true);

	const [token] = useState(() => getToken());
	const [providers, setProviders] = useState<ProviderSummary[]>([]);
	const [sessions, setSessions] = useState<HostSession[]>([]);
	const [session, setSession] = useState<HostSession | null>(null);
	const [stream, setStream] = useState<HostEvent[]>([]);
	const [pendingRequests, setPendingRequests] = useState<PendingRequest[]>([]);
	const [prompt, setPrompt] = useState("");
	const [draftImages, setDraftImages] = useState<DraftImage[]>([]);
	const [showNewSession, setShowNewSession] = useState(false);
	const [newCwd, setNewCwd] = useState(loaderData.defaultCwd);
	const [newTitle, setNewTitle] = useState("");
	const [isCreating, setIsCreating] = useState(false);
	const [initialLoading, setInitialLoading] = useState(true);
	const [now, setNow] = useState(() => Date.now());
	const [streamState, setStreamState] = useState<"connected" | "reconnecting">("connected");
	const [archiveConfirmId, setArchiveConfirmId] = useState<string | null>(null);
	const isArchivedView = location.pathname === "/archived";
	const activeSessions = sessions.filter((candidate) => !candidate.archived);
	const archivedSessions = sessions.filter((candidate) => candidate.archived);

	// Group tool-calls with their results
	const grouped = useMemo(() => groupStream(stream), [stream]);

	useEffect(() => {
		draftImagesRef.current = draftImages;
	}, [draftImages]);

	// Auth guard
	useEffect(() => {
		if (!token) navigate("/login", { replace: true });
	}, [token, navigate]);

	// Fetch sessions
	useEffect(() => {
		if (!token) return;
		fetchProviders(token)
			.then(({ providers: nextProviders }) => setProviders(nextProviders))
			.catch(() => {});
	}, [token]);

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
		setStreamState("connected");
		setDraftImages((prev) => {
			for (const image of prev) {
				URL.revokeObjectURL(image.url);
			}
			return [];
		});
		if (fileInputRef.current) {
			fileInputRef.current.value = "";
		}

		const controller = connectSSE(
			token,
			selectedId,
			(msg) => {
				startTransition(() => {
					if (msg.type === "snapshot") {
						setSession(msg.payload.session);
						setStream(msg.payload.events);
						setPendingRequests(msg.payload.pendingRequests.filter((r) => r.status === "pending"));
						setSessions((prev) =>
							prev.map((s) => (s.id === msg.payload.session.id ? msg.payload.session : s)),
						);
					} else if (msg.type === "session") {
						setSession(msg.payload);
						setSessions((prev) => prev.map((s) => (s.id === msg.payload.id ? msg.payload : s)));
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
			(state) => setStreamState(state),
		);

		return () => controller.abort();
	}, [selectedId, token]);

	useEffect(() => {
		if (selectedId) {
			return;
		}

		setSession(null);
		setStream([]);
		setPendingRequests([]);
		setStreamState("connected");
	}, [selectedId]);

	// Auto-scroll
	useEffect(() => {
		if (isAtBottom.current && scrollRef.current) {
			scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
		}
	}, [stream]);

	useEffect(() => {
		const timer = setInterval(() => {
			setNow(Date.now());
		}, 1000);

		return () => clearInterval(timer);
	}, []);

	useEffect(() => {
		return () => {
			for (const image of draftImagesRef.current) {
				URL.revokeObjectURL(image.url);
			}
		};
	}, []);

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
			navigate(`/sessions/${result.session.id}`);
			setShowNewSession(false);
			setNewTitle("");
			setTimeout(() => textareaRef.current?.focus(), 100);
		} catch (err) {
			console.error("Failed to create session:", err);
		} finally {
			setIsCreating(false);
		}
	}, [token, newCwd, newTitle, navigate]);

	const handleSend = useCallback(async () => {
		if (!token || !selectedId || session?.status === "running" || session?.status === "retrying") {
			return;
		}
		const text = prompt;
		const images = draftImages;
		if (text.trim().length === 0 && images.length === 0) {
			return;
		}

		setPrompt("");
		setDraftImages([]);
		if (fileInputRef.current) {
			fileInputRef.current.value = "";
		}
		if (textareaRef.current) textareaRef.current.style.height = "auto";

		try {
			await sendInput(
				token,
				selectedId,
				text,
				images.map((image) => image.file),
			);
		} catch {
			setPrompt(text);
			setDraftImages(images);
		}
	}, [token, selectedId, prompt, draftImages, session?.status]);

	const handleInterrupt = useCallback(async () => {
		if (!token || !selectedId) return;
		try {
			await controlSession(token, selectedId, "interrupt");
		} catch {
			/* ignore */
		}
	}, [token, selectedId]);

	const handleArchive = useCallback(
		async (sessionId: string, archived: boolean) => {
			if (!token) {
				return;
			}

			try {
				const result = await setSessionArchived(token, sessionId, archived);
				setSessions((prev) =>
					prev.map((candidate) =>
						candidate.id === result.session.id ? result.session : candidate,
					),
				);
				setSession((prev) => (prev?.id === result.session.id ? result.session : prev));
				setArchiveConfirmId((current) => (current === sessionId ? null : current));

				if (archived) {
					if (selectedId === sessionId) {
						navigate("/");
					}
					return;
				}

				if (isArchivedView) {
					navigate(`/sessions/${sessionId}`);
				}
			} catch (err) {
				console.error("Failed to update archive state:", err);
			}
		},
		[token, navigate, isArchivedView, selectedId],
	);

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

	const addDraftImages = useCallback(async (files: File[]) => {
		const normalizedImages = await Promise.all(files.map(normalizeDraftImage));
		setDraftImages((prev) => [...prev, ...normalizedImages]);
	}, []);

	const handleImageSelect = useCallback(
		(event: React.ChangeEvent<HTMLInputElement>) => {
			const files = Array.from(event.target.files ?? []).filter((file) =>
				file.type.startsWith("image/"),
			);

			if (files.length > 0) {
				void addDraftImages(files);
			}
		},
		[addDraftImages],
	);

	const handlePaste = useCallback(
		(event: React.ClipboardEvent<HTMLTextAreaElement>) => {
			const files = Array.from(event.clipboardData.items)
				.filter((item) => item.type.startsWith("image/"))
				.map((item) => item.getAsFile())
				.filter((file): file is File => file !== null);

			if (files.length === 0) {
				return;
			}

			event.preventDefault();
			void addDraftImages(files);
		},
		[addDraftImages],
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

	const isSessionBusy = session?.status === "running" || session?.status === "retrying";
	const sessionProvider = session
		? providers.find((provider) => provider.id === session.provider)
		: null;
	const canAttachImages = sessionProvider?.capabilities.supportsImages === true;
	const canSend =
		!!selectedId && (prompt.trim().length > 0 || draftImages.length > 0) && !isSessionBusy;

	return (
		<div className="flex h-screen overflow-hidden bg-background">
			{/* ============================================================= */}
			{/* Sidebar                                                        */}
			{/* ============================================================= */}
			<aside className="flex w-56 shrink-0 flex-col border-r border-foreground/10 bg-card/55 backdrop-blur-sm">
				{/* Header */}
				<div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
					<span className="text-[11px] font-semibold uppercase tracking-[0.15em] text-foreground/72">
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
					) : activeSessions.length === 0 ? (
						<div className="py-8 text-center">
							<p className="text-[11px] text-muted-foreground">No sessions</p>
							<button
								type="button"
								onClick={() => setShowNewSession(true)}
								className="mt-2 text-[11px] text-foreground/68 transition hover:text-foreground"
							>
								Create one
							</button>
						</div>
					) : (
						<div className="space-y-px">
							{activeSessions.map((s) => (
								<div
									key={s.id}
									onMouseLeave={() => {
										if (archiveConfirmId === s.id) {
											setArchiveConfirmId(null);
										}
									}}
									className={`group flex items-start gap-1 rounded-md transition ${
										s.status === "running" || s.status === "retrying"
											? "sidebar-session-running"
											: ""
									} ${
										selectedId === s.id
											? "border border-foreground/10 bg-accent/90 text-foreground shadow-[inset_0_1px_0_oklch(1_0_0_/_0.03)]"
											: "text-foreground/72 hover:bg-accent/65 hover:text-foreground"
									}`}
								>
									<button
										type="button"
										onClick={() => navigate(`/sessions/${s.id}`)}
										title={getSidebarTitle(s)}
										className="min-w-0 flex-1 px-2.5 py-2 text-left"
									>
										<div className="flex items-center gap-2">
											<StatusDot status={s.status} />
											<span className="line-clamp-1 min-w-0 flex-1 pr-1 text-xs">{s.title}</span>
											{s.status === "failed" && (
												<CircleX className="ml-auto size-3 shrink-0 text-destructive/70" />
											)}
										</div>
										<p className="mt-0.5 ml-3.5 truncate text-[10px] text-muted-foreground/82">
											{getSidebarMeta(s, now)}
										</p>
									</button>
									<button
										type="button"
										onClick={() => {
											if (archiveConfirmId === s.id) {
												void handleArchive(s.id, true);
												return;
											}
											setArchiveConfirmId(s.id);
										}}
										className={`mt-2 mr-2 flex size-5 shrink-0 items-center justify-center rounded border transition ${
											archiveConfirmId === s.id
												? "border-foreground/18 bg-accent text-foreground opacity-100"
												: "border-transparent text-muted-foreground/0 opacity-0 group-hover:border-foreground/10 group-hover:text-muted-foreground/82 group-hover:opacity-100 hover:border-foreground/18 hover:text-foreground"
										}`}
										aria-label={
											archiveConfirmId === s.id
												? `Confirm archive ${s.title}`
												: `Archive ${s.title}`
										}
										title={archiveConfirmId === s.id ? "Confirm archive" : "Archive"}
									>
										{archiveConfirmId === s.id ? (
											<Check className="size-3" />
										) : (
											<Archive className="size-3" />
										)}
									</button>
								</div>
							))}
						</div>
					)}
				</div>

				{/* Footer */}
				<div className="shrink-0 border-t border-border px-2 py-2">
					<button
						type="button"
						onClick={() => navigate("/archived")}
						className={`mb-1 flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-[11px] transition ${
							isArchivedView
								? "bg-accent text-foreground"
								: "text-muted-foreground/85 hover:bg-accent hover:text-foreground"
						}`}
					>
						<Archive className="size-3" />
						Archived
						<span className="ml-auto text-[10px] text-muted-foreground/72">
							{archivedSessions.length}
						</span>
					</button>
					<button
						type="button"
						onClick={handleLogout}
						className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-[11px] text-muted-foreground/85 transition hover:bg-accent hover:text-foreground"
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
				{isArchivedView ? (
					<div className="flex flex-1 flex-col overflow-hidden">
						<header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-5">
							<div>
								<h1 className="text-xs font-medium text-foreground">Archived sessions</h1>
								<p className="text-[10px] text-muted-foreground/78">
									Restore a thread to move it back into the main list.
								</p>
							</div>
						</header>
						<div className="flex-1 overflow-y-auto px-5 py-4">
							<div className="mx-auto max-w-3xl">
								{archivedSessions.length === 0 ? (
									<div className="flex h-full min-h-48 items-center justify-center">
										<p className="text-xs text-muted-foreground/72">No archived sessions</p>
									</div>
								) : (
									<div className="space-y-2">
										{archivedSessions.map((archivedSession) => (
											<div
												key={archivedSession.id}
												className="flex items-center justify-between gap-4 rounded-md border border-foreground/10 bg-card/90 px-3 py-3"
											>
												<div className="min-w-0">
													<p className="truncate text-xs font-medium text-foreground">
														{archivedSession.title}
													</p>
													<p className="mt-1 truncate text-[10px] text-muted-foreground/82">
														{archivedSession.cwd}
													</p>
												</div>
												<div className="flex shrink-0 items-center gap-2">
													<button
														type="button"
														onClick={() => navigate(`/sessions/${archivedSession.id}`)}
														className="rounded border border-foreground/10 px-3 py-1.5 text-[11px] text-muted-foreground/85 transition hover:border-foreground/18 hover:text-foreground"
													>
														Open
													</button>
													<button
														type="button"
														onClick={() => handleArchive(archivedSession.id, false)}
														className="flex items-center gap-1.5 rounded bg-foreground px-3 py-1.5 text-[11px] font-medium text-background transition hover:bg-foreground/90"
													>
														<ArchiveRestore className="size-3" />
														Unarchive
													</button>
												</div>
											</div>
										))}
									</div>
								)}
							</div>
						</div>
					</div>
				) : selectedId && session ? (
					<>
						{/* Header */}
						<header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-5">
							<div className="min-w-0">
								<div className="flex items-center gap-2">
									<h1 className="truncate text-xs font-medium text-foreground">{session.title}</h1>
									<span className="shrink-0 text-[10px] text-muted-foreground/78">{session.cwd}</span>
								</div>
							</div>
							<div className="flex shrink-0 items-center gap-3">
								<div className="flex items-center gap-1.5">
									<StatusDot status={session.status} />
									<span className="text-[10px] text-muted-foreground/82">
										{formatStatus(session, now)}
									</span>
									{streamState === "reconnecting" && (
										<span className="rounded border border-foreground/12 px-1.5 py-px text-[9px] uppercase tracking-[0.12em] text-muted-foreground/82">
											Reconnecting
										</span>
									)}
								</div>
								{(session.status === "running" || session.status === "retrying") && (
									<button
										type="button"
										onClick={handleInterrupt}
										className="flex items-center gap-1.5 rounded border border-foreground/10 px-2 py-1 text-[11px] text-muted-foreground/82 transition hover:border-foreground/22 hover:text-foreground"
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
							{grouped.length === 0 &&
							session.status !== "running" &&
							session.status !== "retrying" ? (
								<div className="flex h-full items-center justify-center">
									<p className="text-xs text-muted-foreground/72">Send a message to start</p>
								</div>
							) : (
								<div className="mx-auto max-w-3xl">
									{getStatusMessage(session) && (
										<div className="mb-3 rounded-md border border-foreground/10 bg-card/90 px-3 py-2 text-[11px] text-muted-foreground/88">
											{getStatusMessage(session)}
										</div>
									)}
									{grouped.map((group) => (
										<GroupedEntryRenderer
											key={group.type === "tool" ? group.call.id : group.entry.id}
											group={group}
										/>
									))}
									{(session.status === "running" || session.status === "retrying") && (
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
							<PendingRequestBanner request={pendingRequests[0]} onRespond={handleRespond} />
						)}

						{/* Input */}
						<div className="shrink-0 border-t border-border px-5 py-3">
							<div className="mx-auto max-w-3xl">
								<div className="relative rounded-md border border-foreground/10 bg-card/92 shadow-[inset_0_1px_0_oklch(1_0_0_/_0.03)] transition-colors focus-within:border-foreground/22">
									<input
										ref={fileInputRef}
										type="file"
										accept="image/*"
										multiple
										onChange={handleImageSelect}
										className="hidden"
									/>
									{draftImages.length > 0 && (
										<div className="flex flex-wrap gap-2 border-b border-border px-3 py-2">
											{draftImages.map((image, index) => (
												<div
													key={image.url}
													className="relative overflow-hidden rounded-md border border-foreground/10 bg-background"
												>
													<img
														src={image.url}
														alt={image.name}
														className="h-20 w-20 object-cover"
													/>
													<button
														type="button"
														onClick={() =>
															setDraftImages((prev) => {
																const nextImages = [...prev];
																const [removedImage] = nextImages.splice(index, 1);

																if (removedImage) {
																	URL.revokeObjectURL(removedImage.url);
																}

																return nextImages;
															})
														}
														className="absolute top-1 right-1 flex size-5 items-center justify-center rounded-full bg-background/92 text-foreground/72 shadow-sm transition hover:text-foreground"
														aria-label={`Remove ${image.name}`}
													>
														<X className="size-3" />
													</button>
												</div>
											))}
										</div>
									)}
									<textarea
										ref={textareaRef}
										rows={1}
										value={prompt}
										onChange={(e) => {
											setPrompt(e.target.value);
											autoResize(e.currentTarget);
										}}
										onKeyDown={handleKeyDown}
										onPaste={handlePaste}
										placeholder={
											isSessionBusy
												? "Claude is working..."
												: canAttachImages
													? "Message Claude... paste images or attach files"
													: "Message Claude... (Enter to send)"
										}
										disabled={isSessionBusy}
										className="w-full resize-none bg-transparent px-3 py-2.5 pr-20 text-xs text-foreground outline-none placeholder:text-muted-foreground/60 disabled:cursor-not-allowed disabled:opacity-60"
									/>
									{canAttachImages && (
										<button
											type="button"
											onClick={() => fileInputRef.current?.click()}
											disabled={isSessionBusy}
											className="absolute right-10 bottom-2 flex size-7 items-center justify-center rounded border border-foreground/10 bg-background text-muted-foreground/82 transition hover:border-foreground/22 hover:text-foreground disabled:opacity-30"
											title="Attach images"
										>
											<ImagePlus className="size-3.5" />
										</button>
									)}
									<button
										type="button"
										onClick={handleSend}
										disabled={!canSend}
										className="absolute right-2 bottom-2 flex size-7 items-center justify-center rounded bg-foreground text-background shadow-[0_0_18px_oklch(1_0_0_/_0.12)] transition hover:bg-foreground/85 disabled:opacity-20"
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
							<label className="mb-1.5 block text-[11px] text-muted-foreground/88">Directory</label>
							<div className="relative">
								<FolderOpen className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/82" />
								<input
									type="text"
									value={newCwd}
									onChange={(e) => setNewCwd(e.target.value)}
									placeholder="/path/to/project"
									className="h-9 w-full rounded-md border border-foreground/10 bg-background pl-8 pr-3 text-xs text-foreground outline-none transition placeholder:text-muted-foreground/58 focus:border-foreground/22 focus:ring-1 focus:ring-foreground/16"
								/>
							</div>
						</div>
						<div>
							<label className="mb-1.5 block text-[11px] text-muted-foreground/88">
								Title <span className="text-muted-foreground/58">(optional)</span>
							</label>
							<input
								type="text"
								value={newTitle}
								onChange={(e) => setNewTitle(e.target.value)}
								placeholder="My project"
								className="h-9 w-full rounded-md border border-foreground/10 bg-background px-3 text-xs text-foreground outline-none transition placeholder:text-muted-foreground/58 focus:border-foreground/22 focus:ring-1 focus:ring-foreground/16"
							/>
						</div>
					</div>
					<DialogFooter>
						<button
							type="button"
							onClick={() => setShowNewSession(false)}
							className="rounded-md border border-foreground/10 px-3 py-1.5 text-xs text-muted-foreground/85 transition hover:bg-accent hover:text-foreground"
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
