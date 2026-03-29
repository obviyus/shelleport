import {
	Archive,
	ArchiveRestore,
	Check,
	CircleStop,
	CircleX,
	ClipboardCopy,
	Paperclip,
	Loader2,
	LogOut,
	Menu,
	Pencil,
	Pin,
	Plus,
	Search,
	Send,
	Sparkles,
	Trash2,
	X,
} from "lucide-react";
import {
	startTransition,
	useCallback,
	useDeferredValue,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";

import type { AppBootData } from "~/client/boot";
import { useNow } from "~/client/use-now";
import { SessionLauncher } from "~/client/components/session-launcher";
import { SessionTranscript } from "~/client/components/session-transcript";
import { useToast } from "~/client/components/toast";
import { Sheet, SheetContent, SheetTitle } from "~/client/components/ui/sheet";
import { matchAppRoute } from "~/client/routes";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "~/client/components/ui/dialog";
import {
	connectSSE,
	controlSession,
	createSession,
	deleteQueuedInput,
	deleteSession,
	fetchProviders,
	fetchSessionDetail,
	fetchSessions,
	respondToRequest,
	sendInput,
	setSessionArchived,
	updateQueuedInput,
	updateSessionMeta,
} from "~/client/api";
import type {
	HostEvent,
	HostSession,
	PendingRequest,
	PermissionMode,
	ProviderLimitState,
	ProviderModel,
	ProviderSummary,
	QueuedSessionInput,
	RequestResponsePayload,
	SessionLimit,
	SessionStatus,
} from "~/shared/shelleport";
import { useCurrentRoute, useRouter } from "~/client/router";
import {
	type DraftAttachment,
	DraftAttachmentPreview,
	formatStatus,
	formatSessionLimitLabel,
	formatSessionLimitReset,
	formatSessionLimitUsage,
	getSessionHeaderBadges,
	getSidebarMeta,
	getSidebarTitle,
	getStatusMessage,
	groupStream,
	orderSessionLimits,
	normalizeDraftAttachment,
	StatusDot,
	copyToClipboard,
	streamToMarkdown,
} from "~/client/session-stream";

function requestNotificationPermission() {
	if (typeof window === "undefined" || !("Notification" in window)) {
		return;
	}

	if (Notification.permission === "default") {
		void Notification.requestPermission();
	}
}

function isActiveStatus(status: HostSession["status"]) {
	return status === "running" || status === "retrying";
}

export function shouldNotifySessionCompletion(
	previousStatus: HostSession["status"] | null,
	nextStatus: HostSession["status"],
) {
	return (
		previousStatus !== null &&
		isActiveStatus(previousStatus) &&
		!isActiveStatus(nextStatus) &&
		nextStatus !== "waiting"
	);
}

export function getSessionCompletionNotificationBody(session: HostSession) {
	return session.status === "failed"
		? `Failed: ${session.statusDetail.message ?? "unknown error"}`
		: "Task complete";
}

export function shouldInterruptOnCtrlC(
	event: Pick<KeyboardEvent, "key" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey">,
	selectionText: string,
	session: HostSession | null,
) {
	if (event.key !== "c" || !event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) {
		return false;
	}

	if (selectionText.length > 0) {
		return false;
	}

	return session?.status === "running" || session?.status === "retrying";
}

export function shouldShowReconnectBanner(
	isSessionPending: boolean,
	streamState: "connected" | "reconnecting",
) {
	return !isSessionPending && streamState === "reconnecting";
}

function notifySessionComplete(session: HostSession) {
	if (typeof window === "undefined" || !("Notification" in window)) {
		return;
	}

	if (Notification.permission !== "granted" || document.hasFocus()) {
		return;
	}

	new Notification(session.title, {
		body: getSessionCompletionNotificationBody(session),
		tag: `shelleport-${session.id}`,
	});
}

function orderSessions(nextSessions: HostSession[]) {
	return [...nextSessions].sort((left, right) => {
		if (left.archived !== right.archived) {
			return left.archived ? 1 : -1;
		}

		if (left.pinned !== right.pinned) {
			return left.pinned ? -1 : 1;
		}

		return right.updateTime - left.updateTime;
	});
}

const CLAUDE_BYPASS_WARNING_KEY = "shelleport.claude-bypass-warning-dismissed";

function formatPermissionModeLabel(session: HostSession) {
	if (session.provider !== "claude") {
		return null;
	}

	return session.permissionMode === "bypassPermissions" ? "Bypass permissions" : "Approval prompts";
}

function getSessionLimitProgress(limit: SessionLimit) {
	if (limit.utilization === null) {
		return null;
	}

	return Math.max(0, Math.min(limit.utilization, 100));
}

function getSessionLimitTone(limit: SessionLimit) {
	const utilization = limit.utilization ?? 0;

	if (utilization >= 90) {
		return "bg-red-500 shadow-[0_0_18px_oklch(0.62_0.24_25_/_0.42)]";
	}

	if (utilization >= 75) {
		return "bg-amber-300 shadow-[0_0_18px_oklch(0.86_0.16_92_/_0.34)]";
	}

return "bg-white shadow-[0_0_18px_oklch(1_0_0_/_0.26)]";
}

function formatSidebarCost(costUsd: number) {
	if (costUsd >= 1) {
		return `$${costUsd.toFixed(2)}`;
	}

	if (costUsd >= 0.01) {
		return `$${costUsd.toFixed(3)}`;
	}

	return `$${costUsd.toFixed(4)}`;
}

function SessionModelPicker({
	session,
	models,
	onChangeModel,
}: {
	session: HostSession;
	models: ProviderModel[];
	onChangeModel: (model: string | null) => Promise<void>;
}) {
	const [open, setOpen] = useState(false);
	const buttonRef = useRef<HTMLButtonElement>(null);
	const dropdownRef = useRef<HTMLDivElement>(null);
	const currentModel = models.find((model) => model.id === session.model) ?? null;
	const shortLabel = currentModel?.label ?? "Default model";
	const [pos, setPos] = useState({ top: 0, right: 0 });

	useEffect(() => {
		if (!open) return;

		function handleClick(event: MouseEvent) {
			if (
				buttonRef.current?.contains(event.target as Node) ||
				dropdownRef.current?.contains(event.target as Node)
			) {
				return;
			}

			setOpen(false);
		}

		document.addEventListener("mousedown", handleClick);
		return () => document.removeEventListener("mousedown", handleClick);
	}, [open]);

	function handleToggle() {
		if (!open && buttonRef.current) {
			const rect = buttonRef.current.getBoundingClientRect();
			setPos({
				top: rect.bottom + 4,
				right: window.innerWidth - rect.right,
			});
		}

		setOpen(!open);
	}

	return (
		<>
			<button
				ref={buttonRef}
				type="button"
				onClick={handleToggle}
				title={currentModel?.label ?? "Default model"}
				className="flex items-center justify-center gap-1 rounded border border-foreground/12 px-2 py-1 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 text-[10px] text-muted-foreground/80 transition hover:border-foreground/18 hover:text-foreground"
			>
				<Sparkles className="size-3 md:size-2.5" />
				<span className="hidden md:inline">{shortLabel}</span>
			</button>
			{open &&
				createPortal(
					<div
						ref={dropdownRef}
						style={{ top: pos.top, right: pos.right }}
						className="fixed z-[9999] min-w-[150px] rounded-md border border-foreground/12 bg-card p-1 shadow-lg"
					>
						<button
							type="button"
							onClick={() => {
								void onChangeModel(null);
								setOpen(false);
							}}
							className={`flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-[11px] text-left transition ${
								session.model === null
									? "bg-accent text-foreground"
									: "text-muted-foreground/80 hover:bg-accent/60 hover:text-foreground"
							}`}
						>
							Default
						</button>
						{models.map((model) => (
							<button
								key={model.id}
								type="button"
								onClick={() => {
									void onChangeModel(model.id);
									setOpen(false);
								}}
								className={`flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-[11px] text-left transition ${
									session.model === model.id
										? "bg-accent text-foreground"
										: "text-muted-foreground/80 hover:bg-accent/60 hover:text-foreground"
								}`}
							>
								{model.label}
							</button>
						))}
					</div>,
					document.body,
				)}
		</>
	);
}

function SidebarSessionMeta({ session }: { session: HostSession }) {
	const now = useNow();
	const cost =
		session.usage?.costUsd !== null && session.usage?.costUsd !== undefined
			? formatSidebarCost(session.usage.costUsd)
			: null;

	return (
		<p className="mt-0.5 ml-3.5 flex items-center gap-1.5 truncate text-[10px] text-muted-foreground/86">
			<span className="truncate">{getSidebarMeta(session, now)}</span>
			{cost && <span className="shrink-0 tabular-nums text-muted-foreground/55">{cost}</span>}
		</p>
	);
}

function SidebarLimitsPanel({ limits }: { limits: SessionLimit[] }) {
	const now = useNow();

	if (limits.length === 0) {
		return null;
	}

	return (
		<div className="mb-3 rounded border border-foreground/8 bg-background/30 px-3.5 py-3">
			<div className="mb-3 text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/60">
				Claude limits
			</div>
			<div className="space-y-3.5">
				{limits.map((limit) => (
					<div key={limit.window ?? "unknown"} className="text-[10px]">
						<div className="mb-1.5 flex items-baseline justify-between gap-2">
							<span className="font-medium text-foreground/90">
								{formatSessionLimitLabel(limit.window ?? "")}
							</span>
							<span className="tabular-nums text-muted-foreground/60">
								{formatSessionLimitUsage(limit)}
							</span>
						</div>
						{getSessionLimitProgress(limit) !== null && (
							<div className="h-1 overflow-hidden bg-white/6">
								<div
									className={`h-full transition-[width,background-color,box-shadow] duration-300 ${getSessionLimitTone(limit)}`}
									style={{ width: `${getSessionLimitProgress(limit)}%` }}
								/>
							</div>
						)}
						<div className="mt-1.5 text-[9px] text-muted-foreground/50">
							{formatSessionLimitReset(limit, now)}
						</div>
					</div>
				))}
			</div>
		</div>
	);
}

const SIDEBAR_SHORTCUTS = [
	{ key: "Ctrl/\u2318K", label: "search" },
	{ key: "Ctrl+C", label: "interrupt" },
	{ key: "\u2191\u2193", label: "history" },
] as const;

function SidebarShortcutLegend() {
	return (
		<div className="mb-3 hidden flex-wrap items-center justify-center gap-x-3 gap-y-1.5 text-[9px] text-muted-foreground/70 md:flex">
			{SIDEBAR_SHORTCUTS.map((shortcut) => (
				<span key={shortcut.key} className="inline-flex items-center gap-1">
					<kbd className="rounded border border-foreground/14 bg-background/60 px-1.5 py-0.5 font-mono text-[8px] text-muted-foreground/80">
						{shortcut.key}
					</kbd>
					{shortcut.label}
				</span>
			))}
		</div>
	);
}

function SessionStatusBadge({ session }: { session: HostSession }) {
	const now = useNow();

	return (
		<div className="flex items-center gap-1.5 rounded border border-foreground/12 px-2 py-1">
			<StatusDot status={session.status} />
			<span className="hidden sm:inline text-[10px] text-muted-foreground/80">
				{formatStatus(session, now)}
			</span>
		</div>
	);
}

const PROMPT_HISTORY_KEY = "shelleport.prompt-history";
const PROMPT_HISTORY_MAX = 50;

function readPromptHistory(): string[] {
	if (typeof window === "undefined") {
		return [];
	}

	try {
		const stored = window.localStorage.getItem(PROMPT_HISTORY_KEY);
		return stored ? (JSON.parse(stored) as string[]) : [];
	} catch {
		return [];
	}
}

function savePromptHistory(history: string[]) {
	try {
		window.localStorage.setItem(PROMPT_HISTORY_KEY, JSON.stringify(history));
	} catch {}
}

export function pushPromptHistory(history: string[], prompt: string, max = PROMPT_HISTORY_MAX) {
	return [prompt.trim(), ...history.slice(0, max - 1)];
}

export function getPreviousPromptHistoryState(
	history: string[],
	historyIndex: number,
	prompt: string,
	cursorAtStart: boolean,
	savedDraft: string,
) {
	if (history.length === 0) {
		return null;
	}

	if (!cursorAtStart && prompt.length > 0) {
		return null;
	}

	const nextIndex = Math.min(historyIndex + 1, history.length - 1);
	return {
		historyIndex: nextIndex,
		prompt: history[nextIndex],
		savedDraft: historyIndex === -1 ? prompt : savedDraft,
	};
}

export function getNextPromptHistoryState(
	history: string[],
	historyIndex: number,
	savedDraft: string,
) {
	if (historyIndex < 0) {
		return null;
	}

	const nextIndex = historyIndex - 1;
	return {
		historyIndex: nextIndex,
		prompt: nextIndex === -1 ? savedDraft : history[nextIndex],
		savedDraft,
	};
}

function formatQueuedAttachmentLabel(queuedInput: QueuedSessionInput) {
	const count = queuedInput.attachments.length;

	if (count === 0) {
		return null;
	}

	return `${count} attachment${count === 1 ? "" : "s"}`;
}

export function getDocumentTitle(session: HostSession | null) {
	if (!session) {
		return "shelleport";
	}

	const statusIcon =
		session.status === "running" || session.status === "retrying"
			? "● "
			: session.status === "waiting"
				? "◉ "
				: session.status === "failed"
					? "✗ "
					: "";

	return `${statusIcon}${session.title} — shelleport`;
}

export function getSessionListEmptyState(sessionQuery: string) {
	return sessionQuery.trim().length > 0
		? { actionLabel: null, message: `No results for "${sessionQuery}"` }
		: { actionLabel: "Create one", message: "No sessions" };
}

export function getFirstRunReadiness(providers: ProviderSummary[]) {
	const claude = providers.find((provider) => provider.id === "claude") ?? null;
	const canCreateManagedSession = providers.some(
		(provider) => provider.capabilities.canCreate && provider.status === "ready",
	);

	return {
		canCreateManagedSession,
		claudeReady: claude?.status === "ready",
		claudeStatusDetail: claude?.statusDetail ?? null,
	};
}

export function AppShell({ boot }: { boot: Extract<AppBootData, { authenticated: true }> }) {
	const route = useCurrentRoute();
	const renderRoute =
		typeof window === "undefined" ? route : matchAppRoute(window.location.pathname);
	const { navigate } = useRouter();
	const { showToast } = useToast();
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const draftAttachmentsRef = useRef<DraftAttachment[]>([]);
	const previousSessionStatus = useRef<SessionStatus | null>(null);
	const promptHistory = useRef<string[]>(readPromptHistory());
	const historyIndex = useRef(-1);
	const savedDraft = useRef("");
	const selectedId = renderRoute.kind === "session" ? renderRoute.params.sessionId : null;
	const isSessionRoute = selectedId !== null;
	const isArchivedView = renderRoute.kind === "archived";
	const initialDetail = boot.route.kind === "session" ? boot.sessionDetail : null;

	const [providers, setProviders] = useState<ProviderSummary[]>(boot.providers);
	const [providerLimits, setProviderLimits] = useState<ProviderLimitState>(boot.providerLimits);
	const [sessions, setSessions] = useState<HostSession[]>(boot.sessions);
	const [session, setSession] = useState<HostSession | null>(initialDetail?.session ?? null);
	const [stream, setStream] = useState<HostEvent[]>(initialDetail?.events ?? []);
	const [totalEvents, setTotalEvents] = useState<number>(initialDetail?.totalEvents ?? 0);
	const [pendingRequests, setPendingRequests] = useState<PendingRequest[]>(
		initialDetail?.pendingRequests.filter((request) => request.status === "pending") ?? [],
	);
	const [queuedInputs, setQueuedInputs] = useState<QueuedSessionInput[]>(
		initialDetail?.queuedInputs ?? [],
	);
	const [prompt, setPrompt] = useState("");
	const [draftAttachments, setDraftAttachmentsState] = useState<DraftAttachment[]>([]);
	const [isCreating, setIsCreating] = useState(false);
	const [initialLoading, setInitialLoading] = useState(false);
	const [streamState, setStreamState] = useState<"connected" | "reconnecting">("connected");
	const [archiveConfirmId, setArchiveConfirmId] = useState<string | null>(null);
	const [copiedConversation, setCopiedConversation] = useState(false);
	const [renameState, setRenameState] = useState<{ sessionId: string; title: string } | null>(null);
	const [sidebarOpen, setSidebarOpen] = useState(false);
	const [sessionQuery, setSessionQuery] = useState("");
	const [hasDismissedClaudeBypassWarning, setHasDismissedClaudeBypassWarning] = useState(
		() =>
			typeof window !== "undefined" &&
			window.localStorage.getItem(CLAUDE_BYPASS_WARNING_KEY) === "1",
	);
	const [queuedInputEdit, setQueuedInputEdit] = useState<{ id: string; prompt: string } | null>(
		null,
	);
	const [busyQueuedInputId, setBusyQueuedInputId] = useState<string | null>(null);
	const deferredSessionQuery = useDeferredValue(sessionQuery);
	const selectedSession = useMemo(
		() => (selectedId ? (sessions.find((candidate) => candidate.id === selectedId) ?? null) : null),
		[selectedId, sessions],
	);
	const sessionView = session?.id === selectedId ? session : selectedSession;
	const isSessionPending = isSessionRoute && (sessionView === null || session?.id !== selectedId);
	const { activeSessions, archivedSessions } = useMemo(() => {
		const active: HostSession[] = [];
		const archived: HostSession[] = [];

		for (const candidate of sessions) {
			if (candidate.archived) {
				archived.push(candidate);
				continue;
			}

			active.push(candidate);
		}

		return {
			activeSessions: active,
			archivedSessions: archived,
		};
	}, [sessions]);
	const grouped = useMemo(() => groupStream(stream), [stream]);
	const sessionHeaderBadges = useMemo(() => getSessionHeaderBadges(sessionView), [sessionView]);
	const claudeLimits = useMemo(
		() => orderSessionLimits(providerLimits.claude),
		[providerLimits.claude],
	);
	const creatableProviders = useMemo(
		() =>
			providers.filter(
				(provider) => provider.capabilities.canCreate && provider.status === "ready",
			),
		[providers],
	);
	const createProvider = creatableProviders[0] ?? null;
	const createDisabledReason =
		createProvider !== null
			? null
			: (providers.find((provider) => provider.capabilities.canCreate)?.statusDetail ??
				"No managed provider is available.");
	const showsClaudeLauncherWarning =
		createProvider?.id === "claude" &&
		sessions.length === 0 &&
		renderRoute.kind === "home" &&
		typeof window !== "undefined";
	const showsClaudeBypassWarning = showsClaudeLauncherWarning && !hasDismissedClaudeBypassWarning;
	const isRenaming = renameState !== null && renameState.sessionId === sessionView?.id;
	const renameDraft = isRenaming ? renameState.title : (sessionView?.title ?? "");
	const editingQueuedInputId = queuedInputEdit?.id ?? null;
	const queuedInputDraft = queuedInputEdit?.prompt ?? "";

	function setDraftAttachments(
		updater: DraftAttachment[] | ((previous: DraftAttachment[]) => DraftAttachment[]),
	) {
		setDraftAttachmentsState((previous) => {
			const nextDraftAttachments = typeof updater === "function" ? updater(previous) : updater;
			draftAttachmentsRef.current = nextDraftAttachments;
			return nextDraftAttachments;
		});
	}

	function releaseDraftAttachment(attachment: DraftAttachment) {
		if (attachment.previewUrl) {
			URL.revokeObjectURL(attachment.previewUrl);
		}
	}

	function mergeClaudeLimit(previous: SessionLimit[], next: SessionLimit) {
		if (!next.window) {
			return previous;
		}

		const current = previous.find((candidate) => candidate.window === next.window) ?? null;
		const withoutWindow = previous.filter((candidate) => candidate.window !== next.window);
		return [
			...withoutWindow,
			{
				status: next.status ?? current?.status ?? null,
				resetsAt: next.resetsAt ?? current?.resetsAt ?? null,
				window: next.window,
				isUsingOverage: next.isUsingOverage ?? current?.isUsingOverage ?? null,
				utilization: next.utilization ?? current?.utilization ?? null,
			},
		];
	}

	const replaceSession = useCallback((nextSession: HostSession) => {
		setSessions((previous) =>
			orderSessions(
				previous.map((candidate) => (candidate.id === nextSession.id ? nextSession : candidate)),
			),
		);
	}, []);

	const refreshSessions = useCallback(async (query: string) => {
		const { sessions: nextSessions } = await fetchSessions(query);
		setSessions(orderSessions(nextSessions));
	}, []);

	const hasRunningSession = sessions.some((session) => isActiveStatus(session.status));

	useEffect(() => {
		if (!hasRunningSession) {
			return;
		}

		function handleBeforeUnload(event: BeforeUnloadEvent) {
			event.preventDefault();
			event.returnValue = true;
		}

		window.addEventListener("beforeunload", handleBeforeUnload);
		return () => window.removeEventListener("beforeunload", handleBeforeUnload);
	}, [hasRunningSession]);

	useEffect(() => {
		fetchProviders()
			.then(({ providers: nextProviders }) => setProviders(nextProviders))
			.catch(() => {});
	}, []);

	useEffect(() => {
		let cancelled = false;

		refreshSessions(deferredSessionQuery)
			.then(() => {
				if (!cancelled) {
					setInitialLoading(false);
				}
			})
			.catch(() => {
				if (!cancelled) {
					setInitialLoading(false);
				}
			});

		return () => {
			cancelled = true;
		};
	}, [deferredSessionQuery, refreshSessions]);

	useLayoutEffect(() => {
		if (!selectedId) {
			return;
		}

		if (session?.id === selectedId) {
			return;
		}

		setSession(selectedSession);
		previousSessionStatus.current = null;
		setStream([]);
		setTotalEvents(0);
		setPendingRequests([]);
		setQueuedInputs([]);
		setQueuedInputEdit(null);
		setBusyQueuedInputId(null);
		setStreamState("connected");
		setDraftAttachments((previous) => {
			for (const attachment of previous) {
				releaseDraftAttachment(attachment);
			}

			return [];
		});

		if (fileInputRef.current) {
			fileInputRef.current.value = "";
		}
	}, [selectedId, selectedSession, session?.id]);

	useEffect(() => {
		if (!selectedId) {
			return;
		}

		requestNotificationPermission();
	}, [selectedId]);

	useEffect(() => {
		if (!selectedId) {
			return;
		}

		const controller = connectSSE(
			selectedId,
			(message) => {
				startTransition(() => {
					if (message.type === "snapshot") {
						previousSessionStatus.current = message.payload.session.status;
						setSession(message.payload.session);
						setStream(message.payload.events);
						setTotalEvents(message.payload.totalEvents ?? message.payload.events.length);
						setPendingRequests(
							message.payload.pendingRequests.filter((request) => request.status === "pending"),
						);
						setQueuedInputs(message.payload.queuedInputs);
						replaceSession(message.payload.session);
						return;
					}

					if (message.type === "session") {
						const prevStatus = previousSessionStatus.current;
						previousSessionStatus.current = message.payload.status;

						if (shouldNotifySessionCompletion(prevStatus, message.payload.status)) {
							notifySessionComplete(message.payload);
						}

						setSession(message.payload);
						replaceSession(message.payload);
						return;
					}

					if (message.type === "event") {
						const limit =
							message.payload.data.limit && typeof message.payload.data.limit === "object"
								? (message.payload.data.limit as SessionLimit)
								: null;

						if (limit?.window) {
							setProviderLimits((previous) => ({
								...previous,
								claude: mergeClaudeLimit(previous.claude, limit),
							}));
						}

						setStream((previous) => [...previous, message.payload]);
						setTotalEvents((previous) => previous + 1);
						return;
					}

					if (message.type === "queued-inputs") {
						setQueuedInputs(message.payload);
						return;
					}

					setPendingRequests((previous) =>
						message.payload.status === "pending"
							? [
									...previous.filter((request) => request.id !== message.payload.id),
									message.payload,
								]
							: previous.filter((request) => request.id !== message.payload.id),
					);
				});
			},
			(error) => console.error("SSE error:", error),
			(state) => setStreamState(state),
		);

		return () => controller.abort();
	}, [replaceSession, selectedId]);

	useEffect(() => {
		if (selectedId) {
			return;
		}

		setSession(null);
		setStream([]);
		setTotalEvents(0);
		setPendingRequests([]);
		setQueuedInputs([]);
		setQueuedInputEdit(null);
		setBusyQueuedInputId(null);
		setStreamState("connected");
	}, [selectedId]);

	useEffect(() => {
		document.title = getDocumentTitle(sessionView);

		return () => {
			document.title = "shelleport";
		};
	}, [sessionView?.id, sessionView?.status, sessionView?.title]);

	useEffect(() => {
		return () => {
			for (const attachment of draftAttachmentsRef.current) {
				releaseDraftAttachment(attachment);
			}
		};
	}, []);

	const handleCreateSession = useCallback(
		async (cwd: string, title: string, permissionMode: PermissionMode, model?: string) => {
			if (!cwd.trim() || !createProvider) {
				return;
			}

			setIsCreating(true);

			try {
				const result = await createSession({
					provider: createProvider.id,
					cwd: cwd.trim(),
					permissionMode,
					title: title || undefined,
					model,
				});
				await refreshSessions(sessionQuery);
				navigate(`/sessions/${result.session.id}`);
				setTimeout(() => textareaRef.current?.focus(), 100);
			} catch {
				showToast("error", "Failed to create session");
			} finally {
				setIsCreating(false);
			}
		},
		[createProvider, navigate, refreshSessions, sessionQuery, showToast],
	);

	function dismissClaudeBypassWarning() {
		if (typeof window !== "undefined") {
			window.localStorage.setItem(CLAUDE_BYPASS_WARNING_KEY, "1");
		}

		setHasDismissedClaudeBypassWarning(true);
	}

	const handleSend = useCallback(async () => {
		if (!selectedId) {
			return;
		}

		const nextPrompt = prompt;
		const nextDraftAttachments = draftAttachments;
		const nextFiles = nextDraftAttachments.map((a) => a.file);

		if (nextPrompt.trim().length === 0 && nextFiles.length === 0) {
			return;
		}

		if (nextPrompt.trim().length > 0) {
			promptHistory.current = pushPromptHistory(promptHistory.current, nextPrompt);
			savePromptHistory(promptHistory.current);
		}

		historyIndex.current = -1;
		savedDraft.current = "";
		setPrompt("");
		setDraftAttachments([]);

		if (fileInputRef.current) {
			fileInputRef.current.value = "";
		}

		if (textareaRef.current) {
			textareaRef.current.style.height = "auto";
		}

		try {
			await sendInput(selectedId, nextPrompt, nextFiles);
		} catch {
			setPrompt(nextPrompt);
			setDraftAttachments(nextDraftAttachments);
		}
	}, [draftAttachments, prompt, selectedId]);

	const handleInterrupt = useCallback(async () => {
		if (!selectedId) {
			return;
		}

		try {
			await controlSession(selectedId, "interrupt");
		} catch {}
	}, [selectedId]);

	useEffect(() => {
		function handleCtrlC(event: KeyboardEvent) {
			if (!shouldInterruptOnCtrlC(event, window.getSelection()?.toString() ?? "", sessionView)) {
				return;
			}

			event.preventDefault();
			void handleInterrupt();
		}

		window.addEventListener("keydown", handleCtrlC);
		return () => window.removeEventListener("keydown", handleCtrlC);
	}, [handleInterrupt, sessionView]);

	const handleArchive = useCallback(
		async (sessionId: string, archived: boolean) => {
			try {
				const result = await setSessionArchived(sessionId, archived);
				await refreshSessions(sessionQuery);
				setSession((previous) => (previous?.id === result.session.id ? result.session : previous));
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
			} catch {
				showToast("error", "Failed to update archive state");
			}
		},
		[isArchivedView, navigate, refreshSessions, selectedId, sessionQuery, showToast],
	);

	const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

	const handleDelete = useCallback(
		async (sessionId: string) => {
			try {
				await deleteSession(sessionId);
				await refreshSessions(sessionQuery);
				setDeleteConfirmId(null);

				if (selectedId === sessionId) {
					navigate("/");
				}
			} catch (error) {
				console.error("Failed to delete session:", error);
			}
		},
		[navigate, refreshSessions, selectedId, sessionQuery],
	);

	const handleCopyConversation = useCallback(() => {
		void copyToClipboard(streamToMarkdown(stream)).then(() => {
			setCopiedConversation(true);
			setTimeout(() => setCopiedConversation(false), 2000);
		});
	}, [stream]);

	const loadEarlierEvents = useCallback(
		async (before: number) => {
			if (!selectedId) {
				throw new Error("Cannot load earlier events without a selected session");
			}

			const detail = await fetchSessionDetail(selectedId, { before });
			return {
				events: detail.events,
				totalEvents: detail.totalEvents,
			};
		},
		[selectedId],
	);

	const prependEarlierEvents = useCallback((page: { events: HostEvent[]; totalEvents: number }) => {
		setStream((previous) => [...page.events, ...previous]);
		setTotalEvents(page.totalEvents);
	}, []);

	const handleRespond = useCallback(
		async (requestId: string, payload: RequestResponsePayload) => {
			const previousPendingRequests = pendingRequests;
			setPendingRequests((previous) => previous.filter((request) => request.id !== requestId));
			try {
				await respondToRequest(requestId, payload);
			} catch {
				setPendingRequests(previousPendingRequests);
				showToast("error", "Failed to respond to request");
			}
		},
		[pendingRequests, showToast],
	);

	const handleStartQueuedInputEdit = useCallback((queuedInput: QueuedSessionInput) => {
		setQueuedInputEdit({ id: queuedInput.id, prompt: queuedInput.prompt });
	}, []);

	const handleCancelQueuedInputEdit = useCallback(() => {
		setQueuedInputEdit(null);
	}, []);

	const runQueuedInputAction = useCallback(
		async (queuedInputId: string, action: () => Promise<void>, errorMessage: string) => {
			setBusyQueuedInputId(queuedInputId);

			try {
				await action();
			} catch {
				showToast("error", errorMessage);
			} finally {
				setBusyQueuedInputId((current) => (current === queuedInputId ? null : current));
			}
		},
		[showToast],
	);

	const handleSaveQueuedInput = useCallback(async () => {
		if (!selectedId || !queuedInputEdit || queuedInputEdit.prompt.trim().length === 0) {
			return;
		}

		const nextQueuedInputEdit = queuedInputEdit;
		await runQueuedInputAction(
			nextQueuedInputEdit.id,
			async () => {
				await updateQueuedInput(selectedId, nextQueuedInputEdit.id, {
					prompt: nextQueuedInputEdit.prompt.trim(),
				});
				setQueuedInputEdit(null);
			},
			"Failed to update queued message",
		);
	}, [queuedInputEdit, runQueuedInputAction, selectedId]);

	const handleDeleteQueuedInput = useCallback(
		async (queuedInputId: string) => {
			if (!selectedId) {
				return;
			}

			await runQueuedInputAction(
				queuedInputId,
				async () => {
					await deleteQueuedInput(selectedId, queuedInputId);

					if (editingQueuedInputId === queuedInputId) {
						setQueuedInputEdit(null);
					}
				},
				"Failed to delete queued message",
			);
		},
		[editingQueuedInputId, runQueuedInputAction, selectedId],
	);

	const applySessionMetaUpdate = useCallback(
		async (sessionId: string, payload: SessionMetaPayload) => {
			const result = await updateSessionMeta(sessionId, payload);
			await refreshSessions(sessionQuery);
			setSession((previous) => (previous?.id === result.session.id ? result.session : previous));
			return result.session;
		},
		[refreshSessions, sessionQuery],
	);

	const handlePinned = useCallback(
		async (sessionId: string, pinned: boolean) => {
			try {
				await applySessionMetaUpdate(sessionId, { pinned });
			} catch {
				showToast("error", "Failed to update pin state");
			}
		},
		[applySessionMetaUpdate, showToast],
	);

	const handleChangeModel = useCallback(
		async (sessionId: string, model: string | null) => {
			try {
				await applySessionMetaUpdate(sessionId, { model });
			} catch {
				showToast("error", "Failed to update model");
			}
		},
		[applySessionMetaUpdate, showToast],
	);

	const handleRename = useCallback(async () => {
		if (!session || !isRenaming) {
			return;
		}

		const title = renameDraft.trim();

		if (title.length === 0 || title === session.title) {
			setRenameState(null);
			return;
		}

		try {
			await applySessionMetaUpdate(session.id, { title });
			setRenameState(null);
		} catch {
			showToast("error", "Failed to rename session");
		}
	}, [applySessionMetaUpdate, isRenaming, renameDraft, session, showToast]);

	const addDraftAttachments = useCallback(async (files: File[]) => {
		const normalized = await Promise.all(files.map(normalizeDraftAttachment));
		setDraftAttachments((previous) => [...previous, ...normalized]);
	}, []);

	const handleFileSelect = useCallback(
		(event: React.ChangeEvent<HTMLInputElement>) => {
			const files = Array.from(event.target.files ?? []);

			if (files.length > 0) {
				void addDraftAttachments(files);
			}
		},
		[addDraftAttachments],
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
			void addDraftAttachments(files);
		},
		[addDraftAttachments],
	);

	const sessionProvider = sessionView
		? providers.find((provider) => provider.id === sessionView.provider)
		: null;
	const canAttach = sessionProvider?.capabilities.supportsAttachments === true;
	const isSessionBusy =
		sessionView?.status === "running" ||
		sessionView?.status === "retrying" ||
		sessionView?.status === "waiting";
	const queuedInputCount = queuedInputs.length;
	const canSend = !!selectedId && (prompt.trim().length > 0 || draftAttachments.length > 0);
	const permissionModeLabel = sessionView ? formatPermissionModeLabel(sessionView) : null;
	const pendingRequest = pendingRequests[0] ?? null;
	const showReconnectBanner = shouldShowReconnectBanner(isSessionPending, streamState);
	const statusMessage = sessionView ? getStatusMessage(sessionView) : null;
	const firstRunReadiness = getFirstRunReadiness(providers);

	function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			void handleSend();
			return;
		}

		if (event.key === "ArrowUp" && promptHistory.current.length > 0) {
			const textarea = event.currentTarget;
			const nextState = getPreviousPromptHistoryState(
				promptHistory.current,
				historyIndex.current,
				prompt,
				textarea.selectionStart === 0 && textarea.selectionEnd === 0,
				savedDraft.current,
			);

			if (!nextState) {
				return;
			}

			event.preventDefault();
			historyIndex.current = nextState.historyIndex;
			savedDraft.current = nextState.savedDraft;
			setPrompt(nextState.prompt);
			return;
		}

		if (event.key === "ArrowDown" && historyIndex.current >= 0) {
			const nextState = getNextPromptHistoryState(
				promptHistory.current,
				historyIndex.current,
				savedDraft.current,
			);

			if (!nextState) {
				return;
			}

			event.preventDefault();
			historyIndex.current = nextState.historyIndex;
			savedDraft.current = nextState.savedDraft;
			setPrompt(nextState.prompt);
		}
	}

	function autoResize(element: HTMLTextAreaElement) {
		element.style.height = "auto";
		element.style.height = `${Math.min(element.scrollHeight, 180)}px`;
	}

	function handleLogout() {
		window.location.assign("/logout");
	}

	return (
		<div className="flex h-dvh overflow-hidden bg-background">
			<Dialog
				open={showsClaudeBypassWarning}
				onOpenChange={(open) => {
					if (open) {
						return;
					}

					dismissClaudeBypassWarning();
				}}
			>
				<DialogContent showCloseButton={false} className="max-w-xl border-foreground/14 bg-card">
					<DialogHeader className="text-left">
						<div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-foreground/56">
							Claude setup
						</div>
						<DialogTitle className="text-xl font-medium tracking-[-0.04em] text-foreground">
							Bypass permissions should stay on.
						</DialogTitle>
						<DialogDescription className="text-[12px] leading-[1.7] text-muted-foreground/84">
							Shelleport works best when Claude runs in bypass permissions mode. You can turn it off
							per session, but approval prompts are still rough and may not behave cleanly.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<button
							type="button"
							onClick={dismissClaudeBypassWarning}
							className="inline-flex h-9 items-center justify-center rounded-md bg-foreground px-4 text-sm font-medium text-background transition hover:bg-foreground/90"
						>
							Continue
						</button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
			{/* Sidebar content — shared between desktop aside and mobile Sheet */}
			{(() => {
				const sidebarContent = (
					<>
						<div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
							<span className="text-[11px] font-semibold uppercase tracking-[0.15em] text-foreground/82">
								shelleport
							</span>
							<button
								type="button"
								onClick={() => {
									navigate("/");
									setSidebarOpen(false);
								}}
								className="flex size-10 md:size-6 items-center justify-center rounded text-muted-foreground transition hover:bg-accent hover:text-foreground"
								title="New session"
							>
								<Plus className="size-3.5" />
							</button>
						</div>

						<div className="flex-1 overflow-y-auto px-3 py-3">
							<div className="mb-3">
								<div className="relative">
									<Search className="pointer-events-none absolute top-1/2 left-2.5 size-3 -translate-y-1/2 text-muted-foreground/70" />
									<input
										value={sessionQuery}
										onChange={(event) => setSessionQuery(event.target.value)}
										placeholder="Search chats"
										className="h-10 md:h-8 w-full rounded-md border border-foreground/10 bg-background/40 pr-2 pl-7 text-[11px] text-foreground outline-none transition placeholder:text-muted-foreground/80 focus:border-foreground/18"
									/>
								</div>
							</div>
							{initialLoading ? (
								<div className="flex items-center justify-center py-8">
									<Loader2 className="size-3.5 animate-spin text-muted-foreground" />
								</div>
							) : activeSessions.length === 0 ? (
								(() => {
									const emptyState = getSessionListEmptyState(sessionQuery);

									return (
										<div className="py-8 text-center">
											<p className="text-[11px] text-muted-foreground">{emptyState.message}</p>
											{emptyState.actionLabel && (
												<button
													type="button"
													onClick={() => {
														navigate("/");
														setSidebarOpen(false);
													}}
													className="mt-2 text-[11px] text-foreground/68 transition hover:text-foreground"
												>
													{emptyState.actionLabel}
												</button>
											)}
										</div>
									);
								})()
							) : (
								<div className="space-y-1">
									{activeSessions.map((candidate) => (
										<div
											key={candidate.id}
											onMouseLeave={() => {
												if (archiveConfirmId === candidate.id) {
													setArchiveConfirmId(null);
												}
											}}
											className={`group flex items-start gap-1 rounded-md transition ${
												candidate.status === "running" || candidate.status === "retrying"
													? "sidebar-session-running"
													: ""
											} ${
												selectedId === candidate.id
													? "border border-foreground/10 bg-accent/90 text-foreground shadow-[inset_0_1px_0_oklch(1_0_0_/_0.03)]"
													: "text-foreground/82 hover:bg-accent/65 hover:text-foreground"
											}`}
										>
											<button
												type="button"
												onClick={() => {
													navigate(`/sessions/${candidate.id}`);
													setSidebarOpen(false);
												}}
												title={getSidebarTitle(candidate)}
												className="min-w-0 flex-1 px-2.5 py-2 text-left"
											>
												<div className="flex items-center gap-2">
													<StatusDot status={candidate.status} />
													{candidate.pinned && (
														<Pin className="size-3 shrink-0 text-foreground/70" />
													)}
													<span className="line-clamp-1 min-w-0 flex-1 pr-1 text-xs">
														{candidate.title}
													</span>
													{candidate.status === "failed" && (
														<CircleX className="ml-auto size-3 shrink-0 text-destructive/70" />
													)}
												</div>
												<SidebarSessionMeta session={candidate} />
											</button>
											<button
												type="button"
												onClick={() => void handlePinned(candidate.id, !candidate.pinned)}
												className={`mt-2 flex size-8 md:size-5 shrink-0 items-center justify-center rounded border transition ${
													candidate.pinned
														? "border-foreground/12 bg-accent text-foreground opacity-100"
														: "border-foreground/8 text-muted-foreground/50 active:bg-accent active:text-foreground md:border-transparent md:text-muted-foreground/0 md:opacity-0 md:group-hover:border-foreground/10 md:group-hover:text-muted-foreground/86 md:group-hover:opacity-100 md:hover:border-foreground/18 md:hover:text-foreground"
												}`}
												aria-label={
													candidate.pinned ? `Unpin ${candidate.title}` : `Pin ${candidate.title}`
												}
												title={candidate.pinned ? "Unpin" : "Pin"}
											>
												<Pin className="size-3" />
											</button>
											<button
												type="button"
												onClick={() => {
													if (archiveConfirmId === candidate.id) {
														void handleArchive(candidate.id, true);
														return;
													}

													setArchiveConfirmId(candidate.id);
												}}
												className={`mt-2 mr-2 flex size-8 md:size-5 shrink-0 items-center justify-center rounded border transition ${
													archiveConfirmId === candidate.id
														? "border-foreground/18 bg-accent text-foreground opacity-100"
														: "border-foreground/8 text-muted-foreground/50 active:bg-accent active:text-foreground md:border-transparent md:text-muted-foreground/0 md:opacity-0 md:group-hover:border-foreground/10 md:group-hover:text-muted-foreground/86 md:group-hover:opacity-100 md:hover:border-foreground/18 md:hover:text-foreground"
												}`}
												aria-label={
													archiveConfirmId === candidate.id
														? `Confirm archive ${candidate.title}`
														: `Archive ${candidate.title}`
												}
												title={archiveConfirmId === candidate.id ? "Confirm archive" : "Archive"}
											>
												{archiveConfirmId === candidate.id ? (
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

						<div className="shrink-0 px-3 pt-3">
							<SidebarShortcutLegend />
							<SidebarLimitsPanel limits={claudeLimits} />
						</div>
						<div className="shrink-0 border-t border-border px-3 py-3">
							<button
								type="button"
								onClick={() => {
									navigate("/archived");
									setSidebarOpen(false);
								}}
								className={`mb-1 flex w-full items-center gap-2 rounded-md px-2.5 py-3 md:py-2 text-[11px] transition ${
									isArchivedView
										? "bg-accent text-foreground"
										: "text-muted-foreground/88 hover:bg-accent hover:text-foreground"
								}`}
							>
								<Archive className="size-3" />
								Archived
								<span className="ml-auto text-[10px] text-muted-foreground/80">
									{archivedSessions.length}
								</span>
							</button>
							<button
								type="button"
								onClick={handleLogout}
								className="flex w-full items-center gap-2 rounded-md px-2.5 py-3 md:py-2 text-[11px] text-muted-foreground/88 transition hover:bg-accent hover:text-foreground"
							>
								<LogOut className="size-3" />
								Disconnect
							</button>
						</div>
					</>
				);

				return (
					<>
						{/* Desktop sidebar */}
						<aside className="hidden md:flex w-60 shrink-0 flex-col border-r border-foreground/10 bg-card/55 backdrop-blur-md">
							{sidebarContent}
						</aside>

						{/* Mobile sidebar drawer */}
						<Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
							<SheetContent
								side="left"
								showCloseButton={false}
								className="w-72 p-0 bg-card/95 backdrop-blur-md border-r border-foreground/10 flex flex-col"
							>
								<SheetTitle className="sr-only">Navigation</SheetTitle>
								{sidebarContent}
							</SheetContent>
						</Sheet>
					</>
				);
			})()}

			<main className="flex flex-1 flex-col overflow-hidden">
				{isArchivedView ? (
					<div className="flex flex-1 flex-col overflow-hidden">
						<header className="shrink-0 border-b border-border bg-background/72 px-3 md:px-5 py-2.5 backdrop-blur-sm">
							<div className="mx-auto flex max-w-[70rem] items-center gap-2 md:gap-3">
								<button
									type="button"
									onClick={() => setSidebarOpen(true)}
									className="flex md:hidden size-10 items-center justify-center -ml-1 shrink-0 rounded-lg text-foreground/82 active:bg-accent"
									aria-label="Open navigation"
								>
									<Menu className="size-5" />
								</button>
								<h1 className="text-xs font-medium text-foreground">Archived sessions</h1>
								<span className="text-[10px] text-muted-foreground/65">
									Restore a thread to move it back into the main list.
								</span>
							</div>
						</header>
						<div className="flex-1 overflow-y-auto px-3 md:px-6 py-4 md:py-6">
							<div className="mx-auto max-w-[70rem]">
								{archivedSessions.length === 0 ? (
									<div className="flex h-full min-h-48 items-center justify-center">
										<p className="text-xs text-muted-foreground/80">No archived sessions</p>
									</div>
								) : (
									<div className="space-y-2">
										{archivedSessions.map((archivedSession) => (
											<div
												key={archivedSession.id}
												className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-4 rounded-md border border-foreground/10 bg-card/90 px-3 py-3"
											>
												<div className="min-w-0">
													<p className="truncate text-xs font-medium text-foreground">
														{archivedSession.title}
													</p>
													<p className="mt-1 truncate text-[10px] text-muted-foreground/86">
														{archivedSession.cwd}
													</p>
												</div>
												<div
													className="flex shrink-0 items-center gap-2 self-end sm:self-auto"
													onMouseLeave={() => {
														if (deleteConfirmId === archivedSession.id) {
															setDeleteConfirmId(null);
														}
													}}
												>
													<button
														type="button"
														onClick={() => navigate(`/sessions/${archivedSession.id}`)}
														className="rounded border border-foreground/10 px-3 py-2.5 md:py-1.5 text-[11px] text-muted-foreground/88 transition hover:border-foreground/18 hover:text-foreground"
													>
														Open
													</button>
													<button
														type="button"
														onClick={() => void handleArchive(archivedSession.id, false)}
														className="flex items-center gap-1.5 rounded bg-foreground px-3 py-2.5 md:py-1.5 text-[11px] font-medium text-background transition hover:bg-foreground/90"
													>
														<ArchiveRestore className="size-3" />
														Unarchive
													</button>
													<button
														type="button"
														onClick={() => {
															if (deleteConfirmId === archivedSession.id) {
																void handleDelete(archivedSession.id);
																return;
															}

															setDeleteConfirmId(archivedSession.id);
														}}
														className={`flex items-center gap-1.5 rounded border px-3 py-2.5 md:py-1.5 text-[11px] transition ${
															deleteConfirmId === archivedSession.id
																? "border-destructive/40 bg-destructive/10 text-destructive"
																: "border-foreground/10 text-muted-foreground/88 hover:border-destructive/30 hover:text-destructive"
														}`}
													>
														<Trash2 className="size-3" />
														{deleteConfirmId === archivedSession.id ? "Confirm delete" : "Delete"}
													</button>
												</div>
											</div>
										))}
									</div>
								)}
							</div>
						</div>
					</div>
				) : isSessionRoute ? (
					<>
						<header className="shrink-0 border-b border-border bg-background/72 px-3 md:px-5 py-2.5 backdrop-blur-sm">
							<div className="mx-auto flex max-w-[70rem] items-center justify-between gap-2 md:gap-4">
								<button
									type="button"
									onClick={() => setSidebarOpen(true)}
									className="flex md:hidden size-10 items-center justify-center -ml-1 shrink-0 rounded-lg text-foreground/82 active:bg-accent"
									aria-label="Open navigation"
								>
									<Menu className="size-5" />
								</button>
								<div className="flex min-w-0 flex-1 items-center gap-2 md:gap-3">
									{sessionView?.pinned && <Pin className="size-3 shrink-0 text-foreground/82" />}
									{sessionView && isRenaming ? (
										<div className="flex min-w-0 items-center gap-1.5">
											<input
												value={renameDraft}
												onChange={(event) =>
													setRenameState({
														sessionId: sessionView.id,
														title: event.target.value,
													})
												}
												onKeyDown={(event) => {
													if (event.key === "Enter") {
														event.preventDefault();
														void handleRename();
													}

													if (event.key === "Escape") {
														event.preventDefault();
														setRenameState(null);
													}
												}}
												autoFocus
												className="h-6 min-w-0 rounded border border-foreground/12 bg-card px-2 text-xs font-medium text-foreground outline-none"
											/>
											<button
												type="button"
												onClick={() => void handleRename()}
												className="flex size-6 items-center justify-center rounded border border-foreground/10 text-muted-foreground/86 transition hover:border-foreground/18 hover:text-foreground"
												title="Save title"
											>
												<Check className="size-3" />
											</button>
											<button
												type="button"
												onClick={() => {
													setRenameState(null);
												}}
												className="flex size-6 items-center justify-center rounded border border-foreground/10 text-muted-foreground/86 transition hover:border-foreground/18 hover:text-foreground"
												title="Cancel rename"
											>
												<X className="size-3" />
											</button>
										</div>
									) : sessionView ? (
										<>
											<h1 className="truncate text-xs font-medium text-foreground">
												{sessionView.title}
											</h1>
											<button
												type="button"
												onClick={() =>
													setRenameState({ sessionId: sessionView.id, title: sessionView.title })
												}
												className="flex size-10 md:size-5 items-center justify-center rounded text-muted-foreground/80 transition hover:bg-accent hover:text-foreground"
												title="Rename chat"
											>
												<Pencil className="size-2.5" />
											</button>
										</>
									) : (
										<h1 className="truncate text-xs font-medium text-foreground">
											Loading session
										</h1>
									)}
									{sessionView && (
										<span className="hidden text-[10px] text-muted-foreground/65 lg:inline">
											{sessionView.cwd}
										</span>
									)}
								</div>
								<div className="flex shrink-0 items-center gap-1.5">
									{sessionView && <SessionStatusBadge session={sessionView} />}

									{permissionModeLabel && (
										<span className="hidden rounded border border-foreground/12 px-2 py-1 text-[9px] uppercase tracking-[0.08em] text-muted-foreground/80 md:inline-flex">
											{permissionModeLabel}
										</span>
									)}
									{sessionHeaderBadges.map((badge) => (
										<span
											key={badge.key}
											title={badge.title}
											className={`hidden rounded border border-foreground/12 px-2 py-1 text-[9px] uppercase tracking-[0.08em] text-muted-foreground/80 ${
												badge.visibility === "lg"
													? "max-w-[18rem] truncate lg:inline-flex"
													: "xl:inline-flex"
											}`}
										>
											{badge.label}
										</span>
									))}
									{sessionView && (
										<button
											type="button"
											onClick={() => void handlePinned(sessionView.id, !sessionView.pinned)}
											className={`flex items-center justify-center gap-1 rounded border px-2 py-1 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 text-[10px] transition ${
												sessionView.pinned
													? "border-foreground/15 bg-accent text-foreground"
													: "border-foreground/12 text-muted-foreground/80 hover:border-foreground/18 hover:text-foreground"
											}`}
										>
											<Pin className="size-3 md:size-2.5" />
											<span className="hidden md:inline">
												{sessionView.pinned ? "Pinned" : "Pin"}
											</span>
										</button>
									)}
									{sessionView && stream.length > 0 && (
										<button
											type="button"
											onClick={handleCopyConversation}
											className="flex items-center justify-center gap-1 rounded border border-foreground/12 px-2 py-1 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 text-[10px] text-muted-foreground/80 transition hover:border-foreground/18 hover:text-foreground"
										>
											{copiedConversation ? (
												<Check className="size-3 md:size-2.5" />
											) : (
												<ClipboardCopy className="size-3 md:size-2.5" />
											)}
											<span className="hidden md:inline">
												{copiedConversation ? "Copied" : "Copy"}
											</span>
										</button>
									)}
									{sessionView && (sessionProvider?.models ?? []).length > 0 && (
										<SessionModelPicker
											session={sessionView}
											models={sessionProvider?.models ?? []}
											onChangeModel={(model) => handleChangeModel(sessionView.id, model)}
										/>
									)}
									{sessionView &&
										(sessionView.status === "running" || sessionView.status === "retrying") && (
											<button
												type="button"
												onClick={() => void handleInterrupt()}
												className="flex items-center justify-center gap-1 rounded border border-foreground/12 px-2 py-1 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 text-[10px] text-muted-foreground/80 transition hover:border-foreground/18 hover:text-foreground"
											>
												<CircleStop className="size-3 md:size-2.5" />
												<span className="hidden md:inline">Stop</span>
											</button>
										)}
								</div>
							</div>
						</header>

						<SessionTranscript
							firstSequence={stream[0]?.sequence ?? null}
							grouped={grouped}
							hasEarlier={totalEvents > stream.length}
							isRunning={sessionView?.status === "running" || sessionView?.status === "retrying"}
							isSessionPending={isSessionPending}
							loadEarlier={selectedId ? loadEarlierEvents : null}
							onPrependEarlier={prependEarlierEvents}
							onRespond={handleRespond}
							pendingRequest={pendingRequest}
							session={sessionView}
							showReconnectBanner={showReconnectBanner}
							statusMessage={statusMessage}
						/>

						<div className="shrink-0 border-t border-border px-3 md:px-6 py-3 md:py-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:pb-4">
							<div className="mx-auto max-w-[70rem]">
								<div className="rounded-md border border-foreground/10 bg-card/92 shadow-[inset_0_1px_0_oklch(1_0_0_/_0.03)] transition-colors focus-within:border-foreground/22">
									{sessionView && (
										<>
											<input
												ref={fileInputRef}
												type="file"
												multiple
												onChange={handleFileSelect}
												className="hidden"
											/>
											{draftAttachments.length > 0 && (
												<div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
													{draftAttachments.map((attachment, index) => (
														<DraftAttachmentPreview
															key={attachment.previewUrl ?? `${attachment.name}-${index}`}
															attachment={attachment}
															onRemove={() =>
																setDraftAttachments((previous) => {
																	const next = [...previous];
																	const [removed] = next.splice(index, 1);

																	if (removed) {
																		releaseDraftAttachment(removed);
																	}

																	return next;
																})
															}
														/>
													))}
												</div>
											)}
											{queuedInputs.length > 0 && (
												<div className="border-b border-border px-4 py-3">
													<div className="mb-2 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground/80">
														Queued
													</div>
													<div className="space-y-2">
														{queuedInputs.map((queuedInput, index) => {
															const attachmentLabel = formatQueuedAttachmentLabel(queuedInput);
															const isEditing = editingQueuedInputId === queuedInput.id;
															const isBusy = busyQueuedInputId === queuedInput.id;

															return (
																<div
																	key={queuedInput.id}
																	className="rounded-md border border-foreground/10 bg-background/42 px-3 py-2"
																>
																	<div className="flex items-center justify-between gap-3">
																		<div className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground/80">
																			#{index + 1}
																		</div>
																		<div className="flex items-center gap-1">
																			{attachmentLabel && (
																				<div className="mr-1 text-[10px] text-muted-foreground/80">
																					{attachmentLabel}
																				</div>
																			)}
																			{isBusy ? (
																				<div className="flex size-6 items-center justify-center">
																					<Loader2 className="size-3 animate-spin text-muted-foreground/80" />
																				</div>
																			) : isEditing ? (
																				<>
																					<button
																						type="button"
																						onClick={() => void handleSaveQueuedInput()}
																						disabled={queuedInputDraft.trim().length === 0}
																						className="flex size-9 md:size-6 items-center justify-center rounded text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:opacity-30"
																						title="Save queued message"
																					>
																						<Check className="size-3" />
																					</button>
																					<button
																						type="button"
																						onClick={handleCancelQueuedInputEdit}
																						className="flex size-9 md:size-6 items-center justify-center rounded text-muted-foreground transition hover:bg-accent hover:text-foreground"
																						title="Cancel edit"
																					>
																						<X className="size-3" />
																					</button>
																				</>
																			) : (
																				<>
																					<button
																						type="button"
																						onClick={() => handleStartQueuedInputEdit(queuedInput)}
																						className="flex size-9 md:size-6 items-center justify-center rounded text-muted-foreground transition hover:bg-accent hover:text-foreground"
																						title="Edit queued message"
																					>
																						<Pencil className="size-3" />
																					</button>
																					<button
																						type="button"
																						onClick={() =>
																							void handleDeleteQueuedInput(queuedInput.id)
																						}
																						className="flex size-9 md:size-6 items-center justify-center rounded text-muted-foreground transition hover:bg-accent hover:text-foreground"
																						title="Delete queued message"
																					>
																						<Trash2 className="size-3" />
																					</button>
																				</>
																			)}
																		</div>
																	</div>
																	{isEditing ? (
																		<textarea
																			rows={3}
																			value={queuedInputDraft}
																			onChange={(event) =>
																				setQueuedInputEdit((current) =>
																					current === null
																						? null
																						: { ...current, prompt: event.target.value },
																				)
																			}
																			className="mt-2 w-full resize-none rounded border border-foreground/10 bg-background px-2.5 py-2 text-xs leading-[1.7] text-foreground outline-none"
																		/>
																	) : (
																		<div className="mt-1 whitespace-pre-wrap text-xs leading-[1.7] text-foreground/86">
																			{queuedInput.prompt}
																		</div>
																	)}
																</div>
															);
														})}
													</div>
												</div>
											)}
											<div className="flex items-end gap-1.5 px-2 py-2">
												<textarea
													ref={textareaRef}
													rows={1}
													value={prompt}
													onChange={(event) => {
														setPrompt(event.target.value);
														autoResize(event.currentTarget);
													}}
													onKeyDown={handleKeyDown}
													onPaste={handlePaste}
													placeholder={
														isSessionBusy
															? "Claude is working... press Enter to queue"
															: canAttach
																? "Message Claude... attach files or paste images"
																: "Message Claude... (Enter to send)"
													}
													className="min-h-[36px] md:min-h-[28px] flex-1 resize-none bg-transparent px-2 py-1.5 text-xs leading-[1.6] text-foreground outline-none placeholder:text-muted-foreground/80"
												/>
												{canAttach && (
													<button
														type="button"
														onClick={() => fileInputRef.current?.click()}
														className="flex size-9 md:size-7 shrink-0 items-center justify-center rounded border border-foreground/10 bg-background text-muted-foreground/86 transition hover:border-foreground/22 hover:text-foreground"
														title="Attach files"
													>
														<Paperclip className="size-3.5" />
													</button>
												)}
												<button
													type="button"
													onClick={() => void handleSend()}
													disabled={!canSend}
													className="flex size-9 md:size-7 shrink-0 items-center justify-center rounded bg-foreground text-background shadow-[0_0_18px_oklch(1_0_0_/_0.12)] transition hover:bg-foreground/85 disabled:opacity-20"
												>
													<Send className="size-3.5" />
												</button>
											</div>
											{queuedInputCount > 0 && (
												<div className="px-4 pb-1.5 text-[10px] text-muted-foreground/86">
													{queuedInputCount} queued
												</div>
											)}
										</>
									)}
								</div>
							</div>
						</div>
					</>
				) : (
					<>
						<div className="flex md:hidden h-12 shrink-0 items-center border-b border-border bg-background/72 backdrop-blur-sm px-4 gap-3">
							<button
								type="button"
								onClick={() => setSidebarOpen(true)}
								className="flex size-10 items-center justify-center -ml-2 rounded-lg text-foreground/82 active:bg-accent"
								aria-label="Open navigation"
							>
								<Menu className="size-5" />
							</button>
							<span className="text-[11px] font-semibold uppercase tracking-[0.15em] text-foreground/82">
								shelleport
							</span>
						</div>
						{sessions.length === 0 && renderRoute.kind === "home" && (
							<div className="shrink-0 border-b border-border bg-background/50 px-3 py-3 md:px-6 md:py-4">
								<div className="mx-auto max-w-[70rem] rounded-lg border border-foreground/10 bg-card/88 px-4 py-4">
									<div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
										<div>
											<h2 className="text-xs font-medium text-foreground">
												Before your first session
											</h2>
											<p className="mt-1 text-[11px] leading-[1.7] text-muted-foreground/82">
												Check Claude readiness once, then pick a project directory below.
											</p>
										</div>
										<div className="flex flex-col gap-1 text-[11px] text-muted-foreground/82">
											<div className="flex items-center gap-2">
												{firstRunReadiness.claudeReady ? (
													<Check className="size-3 text-foreground/80" />
												) : (
													<X className="size-3 text-destructive/80" />
												)}
												<span>
													Claude CLI {firstRunReadiness.claudeReady ? "ready" : "needs attention"}
												</span>
											</div>
											<div className="flex items-center gap-2">
												{firstRunReadiness.canCreateManagedSession ? (
													<Check className="size-3 text-foreground/80" />
												) : (
													<X className="size-3 text-destructive/80" />
												)}
												<span>
													Managed session launch{" "}
													{firstRunReadiness.canCreateManagedSession ? "ready" : "blocked"}
												</span>
											</div>
										</div>
									</div>
									{firstRunReadiness.claudeStatusDetail && (
										<p className="mt-3 text-[11px] leading-[1.7] text-muted-foreground/78">
											{firstRunReadiness.claudeStatusDetail}
										</p>
									)}
									<div className="mt-3 flex flex-wrap gap-2 text-[11px] text-muted-foreground/82">
										<span className="rounded border border-foreground/10 bg-background px-2 py-1 text-foreground/86">
											claude doctor
										</span>
										<span className="rounded border border-foreground/10 bg-background px-2 py-1 text-foreground/86">
											shelleport doctor
										</span>
									</div>
								</div>
							</div>
						)}
						<SessionLauncher
							key={`${boot.defaultCwd}:${createProvider?.id ?? "none"}`}
							createDisabledReason={createDisabledReason}
							createLabel={createProvider?.label ?? "managed"}
							createProviderId={createProvider?.id ?? null}
							defaultPath={boot.defaultCwd}
							isCreating={isCreating}
							models={createProvider?.models ?? []}
							onCreate={handleCreateSession}
						/>
					</>
				)}
			</main>
		</div>
	);
}
