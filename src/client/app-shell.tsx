import {
	Archive,
	ArchiveRestore,
	Check,
	CircleStop,
	CircleX,
	ImagePlus,
	Loader2,
	LogOut,
	Pencil,
	Pin,
	Plus,
	Search,
	Send,
	X,
} from "lucide-react";
import {
	startTransition,
	useCallback,
	useDeferredValue,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { AppBootData } from "~/client/boot";
import { SessionLauncher } from "~/client/components/session-launcher";
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
	fetchProviders,
	fetchSessions,
	respondToRequest,
	sendInput,
	setSessionArchived,
	updateSessionMeta,
} from "~/client/api";
import type {
	HostEvent,
	HostSession,
	PendingRequest,
	PermissionMode,
	ProviderLimitState,
	ProviderSummary,
	RequestResponsePayload,
	SessionLimit,
} from "~/shared/shelleport";
import { useCurrentRoute, useRouter } from "~/client/router";
import {
	type DraftImage,
	DraftImagePreview,
	formatStatus,
	formatSessionLimitLabel,
	formatSessionLimitReset,
	formatSessionLimitUsage,
	getSessionUsageBadges,
	getSidebarMeta,
	getSidebarTitle,
	getStatusMessage,
	groupStream,
	orderSessionLimits,
	GroupedEntryRenderer,
	normalizeDraftImage,
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

	return session.permissionMode === "dontAsk" ? "Bypass permissions" : "Approval prompts";
}

export function AppShell({ boot }: { boot: Extract<AppBootData, { authenticated: true }> }) {
	const route = useCurrentRoute();
	const { navigate } = useRouter();
	const scrollRef = useRef<HTMLDivElement>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const draftImagesRef = useRef<DraftImage[]>([]);
	const isAtBottom = useRef(true);
	const selectedId = route.kind === "session" ? route.params.sessionId : null;
	const isArchivedView = route.kind === "archived";
	const initialDetail = boot.route.kind === "session" ? boot.sessionDetail : null;

	const [providers, setProviders] = useState<ProviderSummary[]>(boot.providers);
	const [providerLimits, setProviderLimits] = useState<ProviderLimitState>(boot.providerLimits);
	const [sessions, setSessions] = useState<HostSession[]>(boot.sessions);
	const [session, setSession] = useState<HostSession | null>(initialDetail?.session ?? null);
	const [stream, setStream] = useState<HostEvent[]>(initialDetail?.events ?? []);
	const [pendingRequests, setPendingRequests] = useState<PendingRequest[]>(
		initialDetail?.pendingRequests.filter((request) => request.status === "pending") ?? [],
	);
	const [prompt, setPrompt] = useState("");
	const [draftImages, setDraftImages] = useState<DraftImage[]>([]);
	const [isCreating, setIsCreating] = useState(false);
	const [initialLoading, setInitialLoading] = useState(false);
	const [now, setNow] = useState(() => Date.now());
	const [streamState, setStreamState] = useState<"connected" | "reconnecting">("connected");
	const [archiveConfirmId, setArchiveConfirmId] = useState<string | null>(null);
	const [renameDraft, setRenameDraft] = useState("");
	const [isRenaming, setIsRenaming] = useState(false);
	const [sessionQuery, setSessionQuery] = useState("");
	const [showsClaudeBypassWarning, setShowsClaudeBypassWarning] = useState(false);
	const deferredSessionQuery = useDeferredValue(sessionQuery);
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
	const usageBadges = useMemo(() => getSessionUsageBadges(stream, now), [now, stream]);
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
		route.kind === "home" &&
		typeof window !== "undefined";

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
		draftImagesRef.current = draftImages;
	}, [draftImages]);

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

	useEffect(() => {
		setRenameDraft(session?.title ?? "");
		setIsRenaming(false);
	}, [session?.id, session?.title]);

	useEffect(() => {
		if (!selectedId) {
			return;
		}

		if (session?.id !== selectedId) {
			setStream([]);
			setPendingRequests([]);
			setSession(null);
			setStreamState("connected");
			setDraftImages((previous) => {
				for (const image of previous) {
					URL.revokeObjectURL(image.url);
				}

				return [];
			});

			if (fileInputRef.current) {
				fileInputRef.current.value = "";
			}
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
	}, [replaceSession, selectedId, session?.id]);

	useEffect(() => {
		if (selectedId) {
			return;
		}

		setSession(null);
		setStream([]);
		setPendingRequests([]);
		setStreamState("connected");
	}, [selectedId]);

	useEffect(() => {
		if (isAtBottom.current && scrollRef.current) {
			scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
		}
	}, [stream]);

	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, []);

	useEffect(() => {
		return () => {
			for (const image of draftImagesRef.current) {
				URL.revokeObjectURL(image.url);
			}
		};
	}, []);

	useEffect(() => {
		if (!showsClaudeLauncherWarning) {
			setShowsClaudeBypassWarning(false);
			return;
		}

		if (window.localStorage.getItem(CLAUDE_BYPASS_WARNING_KEY) === "1") {
			setShowsClaudeBypassWarning(false);
			return;
		}

		setShowsClaudeBypassWarning(true);
	}, [showsClaudeLauncherWarning]);

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

		setShowsClaudeBypassWarning(false);
	}

	const handleSend = useCallback(async () => {
		if (!selectedId || session?.status === "running" || session?.status === "retrying") {
			return;
		}

		const nextPrompt = prompt;
		const nextImages = draftImages;

		if (nextPrompt.trim().length === 0 && nextImages.length === 0) {
			return;
		}

		setPrompt("");
		setDraftImages([]);

		if (fileInputRef.current) {
			fileInputRef.current.value = "";
		}

		if (textareaRef.current) {
			textareaRef.current.style.height = "auto";
		}

		try {
			await sendInput(
				selectedId,
				nextPrompt,
				nextImages.map((image) => image.file),
			);
		} catch {
			setPrompt(nextPrompt);
			setDraftImages(nextImages);
		}
	}, [draftImages, prompt, selectedId, session?.status]);

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

	const handleRespond = useCallback(async (requestId: string, payload: RequestResponsePayload) => {
		setPendingRequests((previous) => previous.filter((request) => request.id !== requestId));
		try {
			await respondToRequest(requestId, payload);
		} catch (error) {
			console.error("Failed to respond:", error);
		}
	}, []);

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
		if (!session) {
			return;
		}

		const title = renameDraft.trim();

		if (title.length === 0 || title === session.title) {
			setRenameDraft(session.title);
			setIsRenaming(false);
			return;
		}

		try {
			const result = await updateSessionMeta(session.id, { title });
			await refreshSessions(sessionQuery);
			setSession(result.session);
			setRenameDraft(result.session.title);
			setIsRenaming(false);
		} catch (error) {
			console.error("Failed to rename session:", error);
		}
	}, [refreshSessions, renameDraft, session, sessionQuery]);

	const addDraftImages = useCallback(async (files: File[]) => {
		const normalizedImages = await Promise.all(files.map(normalizeDraftImage));
		setDraftImages((previous) => [...previous, ...normalizedImages]);
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

	const sessionProvider = session
		? providers.find((provider) => provider.id === session.provider)
		: null;
	const canAttachImages = sessionProvider?.capabilities.supportsImages === true;
	const isSessionBusy = session?.status === "running" || session?.status === "retrying";
	const canSend =
		!!selectedId && (prompt.trim().length > 0 || draftImages.length > 0) && !isSessionBusy;
	const permissionModeLabel = session ? formatPermissionModeLabel(session) : null;

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
						setShowsClaudeBypassWarning(true);
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
			<aside className="flex w-56 shrink-0 flex-col border-r border-foreground/10 bg-card/55 backdrop-blur-sm">
				<div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
					<span className="text-[11px] font-semibold uppercase tracking-[0.15em] text-foreground/72">
						shelleport
					</span>
					<button
						type="button"
						onClick={() => navigate("/")}
						className="flex size-6 items-center justify-center rounded text-muted-foreground transition hover:bg-accent hover:text-foreground"
						title="New session"
					>
						<Plus className="size-3.5" />
					</button>
				</div>

				<div className="flex-1 overflow-y-auto px-2 py-2">
					<div className="mb-2 px-1">
						<div className="relative">
							<Search className="pointer-events-none absolute top-1/2 left-2.5 size-3 -translate-y-1/2 text-muted-foreground/70" />
							<input
								value={sessionQuery}
								onChange={(event) => setSessionQuery(event.target.value)}
								placeholder="Search chats"
								className="h-8 w-full rounded-md border border-foreground/10 bg-background/40 pr-2 pl-7 text-[11px] text-foreground outline-none transition placeholder:text-muted-foreground/60 focus:border-foreground/18"
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
								onClick={() => navigate("/")}
								className="mt-2 text-[11px] text-foreground/68 transition hover:text-foreground"
							>
								Create one
							</button>
						</div>
					) : (
						<div className="space-y-px">
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
											: "text-foreground/72 hover:bg-accent/65 hover:text-foreground"
									}`}
								>
									<button
										type="button"
										onClick={() => navigate(`/sessions/${candidate.id}`)}
										title={getSidebarTitle(candidate)}
										className="min-w-0 flex-1 px-2.5 py-2 text-left"
									>
										<div className="flex items-center gap-2">
											<StatusDot status={candidate.status} />
											{candidate.pinned && <Pin className="size-3 shrink-0 text-foreground/70" />}
											<span className="line-clamp-1 min-w-0 flex-1 pr-1 text-xs">
												{candidate.title}
											</span>
											{candidate.status === "failed" && (
												<CircleX className="ml-auto size-3 shrink-0 text-destructive/70" />
											)}
										</div>
										<p className="mt-0.5 ml-3.5 truncate text-[10px] text-muted-foreground/82">
											{getSidebarMeta(candidate, now)}
										</p>
									</button>
									<button
										type="button"
										onClick={() => void handlePinned(candidate.id, !candidate.pinned)}
										className={`mt-2 flex size-5 shrink-0 items-center justify-center rounded border transition ${
											candidate.pinned
												? "border-foreground/12 bg-accent text-foreground opacity-100"
												: "border-transparent text-muted-foreground/0 opacity-0 group-hover:border-foreground/10 group-hover:text-muted-foreground/82 group-hover:opacity-100 hover:border-foreground/18 hover:text-foreground"
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
										className={`mt-2 mr-2 flex size-5 shrink-0 items-center justify-center rounded border transition ${
											archiveConfirmId === candidate.id
												? "border-foreground/18 bg-accent text-foreground opacity-100"
												: "border-transparent text-muted-foreground/0 opacity-0 group-hover:border-foreground/10 group-hover:text-muted-foreground/82 group-hover:opacity-100 hover:border-foreground/18 hover:text-foreground"
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

				<div className="shrink-0 border-t border-border px-2 py-2">
					{claudeLimits.length > 0 && (
						<div className="mb-2 rounded-md border border-foreground/10 bg-background/40 px-2.5 py-2">
							<div className="mb-1 text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/68">
								Claude limits
							</div>
							<div className="space-y-1">
								{claudeLimits.map((limit) => (
									<div key={limit.window} className="text-[10px]">
										<div className="flex items-center justify-between gap-2">
											<span className="text-foreground/76">
												{formatSessionLimitLabel(limit.window)}
											</span>
											<span className="text-muted-foreground/76">
												{formatSessionLimitUsage(limit)}
											</span>
										</div>
										<div className="text-[9px] text-muted-foreground/60">
											{formatSessionLimitReset(limit, now)}
										</div>
									</div>
								))}
							</div>
						</div>
					)}
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

			<main className="flex flex-1 flex-col overflow-hidden">
				{isArchivedView ? (
					<div className="flex flex-1 flex-col overflow-hidden">
						<header className="flex min-h-12 shrink-0 items-center justify-between border-b border-border px-5 py-2">
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
														onClick={() => void handleArchive(archivedSession.id, false)}
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
						<header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-5">
							<div className="min-w-0">
								<div className="flex items-center gap-2">
									{session.pinned && <Pin className="size-3 shrink-0 text-foreground/72" />}
									{isRenaming ? (
										<div className="flex min-w-0 items-center gap-1.5">
											<input
												value={renameDraft}
												onChange={(event) => setRenameDraft(event.target.value)}
												onKeyDown={(event) => {
													if (event.key === "Enter") {
														event.preventDefault();
														void handleRename();
													}

													if (event.key === "Escape") {
														event.preventDefault();
														setRenameDraft(session.title);
														setIsRenaming(false);
													}
												}}
												autoFocus
												className="h-7 min-w-0 rounded border border-foreground/12 bg-card px-2 text-xs font-medium text-foreground outline-none"
											/>
											<button
												type="button"
												onClick={() => void handleRename()}
												className="flex size-6 items-center justify-center rounded border border-foreground/10 text-muted-foreground/82 transition hover:border-foreground/18 hover:text-foreground"
												title="Save title"
											>
												<Check className="size-3" />
											</button>
											<button
												type="button"
												onClick={() => {
													setRenameDraft(session.title);
													setIsRenaming(false);
												}}
												className="flex size-6 items-center justify-center rounded border border-foreground/10 text-muted-foreground/82 transition hover:border-foreground/18 hover:text-foreground"
												title="Cancel rename"
											>
												<X className="size-3" />
											</button>
										</div>
									) : (
										<>
											<h1 className="truncate text-xs font-medium text-foreground">
												{session.title}
											</h1>
											<button
												type="button"
												onClick={() => setIsRenaming(true)}
												className="flex size-6 items-center justify-center rounded text-muted-foreground/82 transition hover:bg-accent hover:text-foreground"
												title="Rename chat"
											>
												<Pencil className="size-3" />
											</button>
										</>
									)}
									<span className="shrink-0 text-[10px] text-muted-foreground/78">
										{session.cwd}
									</span>
									{permissionModeLabel && (
										<span className="shrink-0 rounded border border-foreground/10 bg-card/90 px-1.5 py-px text-[9px] uppercase tracking-[0.08em] text-muted-foreground/80">
											{permissionModeLabel}
										</span>
									)}
								</div>
								{usageBadges.length > 0 && (
									<div className="mt-1 flex flex-wrap gap-1.5">
										{usageBadges.map((badge) => (
											<span
												key={badge}
												className="rounded border border-foreground/10 bg-card/90 px-1.5 py-px text-[9px] uppercase tracking-[0.08em] text-muted-foreground/80"
											>
												{badge}
											</span>
										))}
									</div>
								)}
							</div>
							<div className="flex shrink-0 items-center gap-3">
								<button
									type="button"
									onClick={() => void handlePinned(session.id, !session.pinned)}
									className={`flex items-center gap-1.5 rounded border px-2 py-1 text-[11px] transition ${
										session.pinned
											? "border-foreground/18 bg-accent text-foreground"
											: "border-foreground/10 text-muted-foreground/82 hover:border-foreground/22 hover:text-foreground"
									}`}
								>
									<Pin className="size-3" />
									{session.pinned ? "Pinned" : "Pin"}
								</button>
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
										onClick={() => void handleInterrupt()}
										className="flex items-center gap-1.5 rounded border border-foreground/10 px-2 py-1 text-[11px] text-muted-foreground/82 transition hover:border-foreground/22 hover:text-foreground"
									>
										<CircleStop className="size-3" />
										Stop
									</button>
								)}
							</div>
						</header>

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

						{pendingRequests.length > 0 && (
							<PendingRequestBanner request={pendingRequests[0]} onRespond={handleRespond} />
						)}

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
												<DraftImagePreview
													key={image.url}
													image={image}
													onRemove={() =>
														setDraftImages((previous) => {
															const nextImages = [...previous];
															const [removedImage] = nextImages.splice(index, 1);

															if (removedImage) {
																URL.revokeObjectURL(removedImage.url);
															}

															return nextImages;
														})
													}
												/>
											))}
										</div>
									)}
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
										onClick={() => void handleSend()}
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
					<SessionLauncher
						createDisabledReason={createDisabledReason}
						createLabel={createProvider?.label ?? "managed"}
						createProviderId={createProvider?.id ?? null}
						defaultPath={boot.defaultCwd}
						isCreating={isCreating}
						onCreate={handleCreateSession}
					/>
				)}
			</main>
		</div>
	);
}
