import {
	Archive,
	ArchiveRestore,
	Check,
	CircleStop,
	CircleX,
	Paperclip,
	Loader2,
	LogOut,
	Menu,
	Pencil,
	Pin,
	Plus,
	Search,
	Send,
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
import { useNow } from "~/client/use-now";
import type { AppBootData } from "~/client/boot";
import { SessionLauncher } from "~/client/components/session-launcher";
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
	ProviderSummary,
	QueuedSessionInput,
	RequestResponsePayload,
	SessionLimit,
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
	GroupedEntryRenderer,
	normalizeDraftAttachment,
	PendingRequestBanner,
	StatusDot,
} from "~/client/session-stream";

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

function SidebarSessionMeta({ now, session }: { now: number; session: HostSession }) {
	return (
		<p className="mt-0.5 ml-3.5 truncate text-[10px] text-muted-foreground/86">
			{getSidebarMeta(session, now)}
		</p>
	);
}

function SidebarActiveSessions({
	activeSessions,
	archiveConfirmId,
	handleArchive,
	handlePinned,
	navigate,
	selectedId,
	setArchiveConfirmId,
	setSidebarOpen,
}: {
	activeSessions: HostSession[];
	archiveConfirmId: string | null;
	handleArchive: (sessionId: string, archived: boolean) => Promise<void>;
	handlePinned: (sessionId: string, pinned: boolean) => Promise<void>;
	navigate: (path: string) => void;
	selectedId: string | null;
	setArchiveConfirmId: (sessionId: string | null) => void;
	setSidebarOpen: (open: boolean) => void;
}) {
	const now = useNow();

	return (
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
							{candidate.pinned && <Pin className="size-3 shrink-0 text-foreground/70" />}
							<span className="line-clamp-1 min-w-0 flex-1 pr-1 text-xs">{candidate.title}</span>
							{candidate.status === "failed" && (
								<CircleX className="ml-auto size-3 shrink-0 text-destructive/70" />
							)}
						</div>
						<SidebarSessionMeta now={now} session={candidate} />
					</button>
					<button
						type="button"
						onClick={() => void handlePinned(candidate.id, !candidate.pinned)}
						className={`mt-2 flex size-8 md:size-5 shrink-0 items-center justify-center rounded border transition ${
							candidate.pinned
								? "border-foreground/12 bg-accent text-foreground opacity-100"
								: "border-transparent text-muted-foreground/0 opacity-0 group-hover:border-foreground/10 group-hover:text-muted-foreground/86 group-hover:opacity-100 hover:border-foreground/18 hover:text-foreground"
						}`}
						aria-label={candidate.pinned ? `Unpin ${candidate.title}` : `Pin ${candidate.title}`}
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
								: "border-transparent text-muted-foreground/0 opacity-0 group-hover:border-foreground/10 group-hover:text-muted-foreground/86 group-hover:opacity-100 hover:border-foreground/18 hover:text-foreground"
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

function formatQueuedAttachmentLabel(queuedInput: QueuedSessionInput) {
	const count = queuedInput.attachments.length;

	if (count === 0) {
		return null;
	}

	return `${count} attachment${count === 1 ? "" : "s"}`;
}

export function AppShell({ boot }: { boot: Extract<AppBootData, { authenticated: true }> }) {
	const route = useCurrentRoute();
	const renderRoute =
		typeof window === "undefined" ? route : matchAppRoute(window.location.pathname);
	const { navigate } = useRouter();
	const scrollRef = useRef<HTMLDivElement>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const draftAttachmentsRef = useRef<DraftAttachment[]>([]);
	const isAtBottom = useRef(true);
	const selectedId = renderRoute.kind === "session" ? renderRoute.params.sessionId : null;
	const isSessionRoute = selectedId !== null;
	const isArchivedView = renderRoute.kind === "archived";
	const initialDetail = boot.route.kind === "session" ? boot.sessionDetail : null;

	const [providers, setProviders] = useState<ProviderSummary[]>(boot.providers);
	const [providerLimits, setProviderLimits] = useState<ProviderLimitState>(boot.providerLimits);
	const [sessions, setSessions] = useState<HostSession[]>(boot.sessions);
	const [session, setSession] = useState<HostSession | null>(initialDetail?.session ?? null);
	const [stream, setStream] = useState<HostEvent[]>(initialDetail?.events ?? []);
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
	const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
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
		setStream([]);
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

		const controller = connectSSE(
			selectedId,
			(message) => {
				startTransition(() => {
					if (message.type === "snapshot") {
						setSession(message.payload.session);
						setStream(message.payload.events);
						setPendingRequests(
							message.payload.pendingRequests.filter((request) => request.status === "pending"),
						);
						setQueuedInputs(message.payload.queuedInputs);
						replaceSession(message.payload.session);
						return;
					}

					if (message.type === "session") {
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
		setPendingRequests([]);
		setQueuedInputs([]);
		setQueuedInputEdit(null);
		setBusyQueuedInputId(null);
		setStreamState("connected");
	}, [selectedId]);

	useEffect(() => {
		if (isAtBottom.current && scrollRef.current) {
			scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
		}
	}, [stream]);

	useEffect(() => {
		return () => {
			for (const attachment of draftAttachmentsRef.current) {
				releaseDraftAttachment(attachment);
			}
		};
	}, []);

	const handleCreateSession = useCallback(
		async (cwd: string, title: string, permissionMode: PermissionMode) => {
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
				});
				await refreshSessions(sessionQuery);
				navigate(`/sessions/${result.session.id}`);
				setTimeout(() => textareaRef.current?.focus(), 100);
			} catch (error) {
				console.error("Failed to create session:", error);
			} finally {
				setIsCreating(false);
			}
		},
		[createProvider, navigate, refreshSessions, sessionQuery],
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
			} catch (error) {
				console.error("Failed to update archive state:", error);
			}
		},
		[isArchivedView, navigate, refreshSessions, selectedId, sessionQuery],
	);

	const handleDelete = useCallback(
		async (sessionId: string) => {
			try {
				await deleteSession(sessionId);
				await refreshSessions(sessionQuery);
				setDeleteConfirmId(null);

				if (selectedId === sessionId) {
					navigate("/archived");
				}
			} catch (error) {
				console.error("Failed to delete session:", error);
			}
		},
		[navigate, refreshSessions, selectedId, sessionQuery],
	);

	const handleRespond = useCallback(async (requestId: string, payload: RequestResponsePayload) => {
		setPendingRequests((previous) => previous.filter((request) => request.id !== requestId));
		try {
			await respondToRequest(requestId, payload);
		} catch (error) {
			console.error("Failed to respond:", error);
		}
	}, []);

	const handleStartQueuedInputEdit = useCallback((queuedInput: QueuedSessionInput) => {
		setQueuedInputEdit({ id: queuedInput.id, prompt: queuedInput.prompt });
	}, []);

	const handleCancelQueuedInputEdit = useCallback(() => {
		setQueuedInputEdit(null);
	}, []);

	const handleSaveQueuedInput = useCallback(async () => {
		if (!selectedId || !queuedInputEdit || queuedInputEdit.prompt.trim().length === 0) {
			return;
		}

		setBusyQueuedInputId(queuedInputEdit.id);

		try {
			await updateQueuedInput(selectedId, queuedInputEdit.id, {
				prompt: queuedInputEdit.prompt.trim(),
			});
			setQueuedInputEdit(null);
		} catch (error) {
			console.error("Failed to update queued input:", error);
		} finally {
			setBusyQueuedInputId((current) => (current === queuedInputEdit.id ? null : current));
		}
	}, [queuedInputEdit, selectedId]);

	const handleDeleteQueuedInput = useCallback(
		async (queuedInputId: string) => {
			if (!selectedId) {
				return;
			}

			setBusyQueuedInputId(queuedInputId);

			try {
				await deleteQueuedInput(selectedId, queuedInputId);

				if (editingQueuedInputId === queuedInputId) {
					setQueuedInputEdit(null);
				}
			} catch (error) {
				console.error("Failed to delete queued input:", error);
			} finally {
				setBusyQueuedInputId((current) => (current === queuedInputId ? null : current));
			}
		},
		[editingQueuedInputId, selectedId],
	);

	const handlePinned = useCallback(
		async (sessionId: string, pinned: boolean) => {
			try {
				const result = await updateSessionMeta(sessionId, { pinned });
				await refreshSessions(sessionQuery);
				setSession((previous) => (previous?.id === result.session.id ? result.session : previous));
			} catch (error) {
				console.error("Failed to update pinned state:", error);
			}
		},
		[refreshSessions, sessionQuery],
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
			const result = await updateSessionMeta(session.id, { title });
			await refreshSessions(sessionQuery);
			setSession(result.session);
			setRenameState(null);
		} catch (error) {
			console.error("Failed to rename session:", error);
		}
	}, [isRenaming, refreshSessions, renameDraft, session, sessionQuery]);

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

	function handleScroll() {
		const element = scrollRef.current;

		if (!element) {
			return;
		}

		isAtBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 60;
	}

	function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			void handleSend();
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
		<div className="flex h-screen overflow-hidden bg-background">
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
								<div className="py-8 text-center">
									<p className="text-[11px] text-muted-foreground">No sessions</p>
									<button
										type="button"
										onClick={() => {
											navigate("/");
											setSidebarOpen(false);
										}}
										className="mt-2 text-[11px] text-foreground/68 transition hover:text-foreground"
									>
										Create one
									</button>
								</div>
							) : (
								<SidebarActiveSessions
									activeSessions={activeSessions}
									archiveConfirmId={archiveConfirmId}
									handleArchive={handleArchive}
									handlePinned={handlePinned}
									navigate={navigate}
									selectedId={selectedId}
									setArchiveConfirmId={setArchiveConfirmId}
									setSidebarOpen={setSidebarOpen}
								/>
							)}
						</div>

						<div className="shrink-0 px-3 pt-3">
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
												onMouseLeave={() => {
													if (deleteConfirmId === archivedSession.id) {
														setDeleteConfirmId(null);
													}
												}}
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
												<div className="flex shrink-0 items-center gap-2 self-end sm:self-auto">
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
																? "border-destructive/30 bg-destructive/14 text-destructive"
																: "border-foreground/10 text-muted-foreground/88 hover:border-destructive/20 hover:text-destructive/80"
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
									{!isSessionPending && streamState === "reconnecting" && (
										<span className="rounded border border-foreground/10 px-2 py-1 text-[9px] uppercase tracking-[0.08em] text-muted-foreground/80">
											Reconnecting
										</span>
									)}
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

						<div
							ref={scrollRef}
							onScroll={handleScroll}
							className="flex-1 overflow-y-auto px-3 md:px-6 py-4 md:py-6"
						>
							{isSessionPending ? (
								<div className="flex h-full items-center justify-center">
									<Loader2 className="size-4 animate-spin text-muted-foreground/80" />
								</div>
							) : sessionView &&
							  grouped.length === 0 &&
							  sessionView.status !== "running" &&
							  sessionView.status !== "retrying" ? (
								<div className="flex h-full items-center justify-center">
									<p className="text-xs text-muted-foreground/80">Send a message to start</p>
								</div>
							) : sessionView ? (
								<div className="mx-auto max-w-[70rem]">
									{getStatusMessage(sessionView) && (
										<div className="mb-5 rounded-lg border border-foreground/10 bg-card/90 px-4 py-3 text-[11px] text-muted-foreground/88">
											{getStatusMessage(sessionView)}
										</div>
									)}
									{grouped.map((group) => (
										<GroupedEntryRenderer
											key={
												group.type === "tool"
													? group.call.id
													: group.type === "assistant-text-run"
														? (group.entries[0]?.id ?? "assistant-text-run")
														: group.entry.id
											}
											group={group}
										/>
									))}
									{(sessionView.status === "running" || sessionView.status === "retrying") && (
										<div className="animate-thinking mt-1 flex gap-1 py-2">
											<span className="size-1 rounded-full bg-foreground" />
											<span className="size-1 rounded-full bg-foreground" />
											<span className="size-1 rounded-full bg-foreground" />
										</div>
									)}
								</div>
							) : null}
						</div>

						{sessionView && pendingRequests.length > 0 && (
							<PendingRequestBanner request={pendingRequests[0]} onRespond={handleRespond} />
						)}

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
						<SessionLauncher
							key={`${boot.defaultCwd}:${createProvider?.id ?? "none"}`}
							createDisabledReason={createDisabledReason}
							createLabel={createProvider?.label ?? "managed"}
							createProviderId={createProvider?.id ?? null}
							defaultPath={boot.defaultCwd}
							isCreating={isCreating}
							onCreate={handleCreateSession}
						/>
					</>
				)}
			</main>
		</div>
	);
}
