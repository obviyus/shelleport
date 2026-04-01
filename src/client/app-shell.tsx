import {
	Archive,
	ArchiveRestore,
	Check,
	ChevronDown,
	ChevronLeft,
	CircleStop,
	CircleX,
	ClipboardCopy,
	EllipsisVertical,
	FileText,
	Eye,
	EyeOff,
	File,
	FileDown,
	Info,
	Folder,
	FolderTree,
	Loader2,
	LogOut,
	Menu,
	Mic,
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
	Suspense,
	useCallback,
	useDeferredValue,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";

import type { AppBootData } from "~/client/boot";
import { useNow } from "~/client/use-now";
import { SessionLauncher } from "~/client/components/session-launcher";
import { SessionTranscript } from "~/client/components/session-transcript";
import { writeLastSessionPreferences } from "~/client/session-preferences";
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
	deleteProject as deleteProjectApi,
	deleteQueuedInput,
	deleteSession,
	fetchDirectory,
	fetchProviders,
	fetchSessionDetail,
	fetchSessions,
	respondToRequest,
	sendInput,
	setSessionArchived,
	updateQueuedInput,
	updateSessionMeta,
} from "~/client/api";
import {
	getDefaultEffortLevel,
	getSupportedEffortLevels,
	normalizeEffortLevel,
	type DirectoryListing,
	type EffortLevel,
	type HostEvent,
	type HostSession,
	type PendingRequest,
	type PermissionMode,
	type Project,
	type ProviderId,
	type ProviderLimitState,
	type ProviderModel,
	type ProviderSummary,
	type QueuedSessionInput,
	type RequestResponsePayload,
	type SessionLimit,
	type SessionMetaPayload,
	type SessionStatus,
} from "~/shared/shelleport";
import { useCurrentRoute, useRouter } from "~/client/router";
import {
	type DraftAttachment,
	DraftAttachmentPreview,
	formatStatus,
	formatSessionLimitLabel,
	formatSessionLimitReset,
	formatSessionLimitUsage,
	friendlyModelLabel,
	getSessionHeaderBadges,
	type SessionHeaderBadge,
	getSidebarMeta,
	getSidebarTitle,
	getStatusMessage,
	groupStream,
	orderSessionLimits,
	normalizeDraftAttachment,
	StatusDot,
	copyToClipboard,
	streamToMarkdown,
	getStreamEditDiffs,
	LazyEditDiff,
	type FileEditDiff,
} from "~/client/session-stream";
import { VoiceWaveform } from "~/client/components/voice-waveform";
import { type VoiceInputState, createVoiceSession } from "~/client/voice-input";

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

export function shouldShowReconnectIndicator(
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
const HIDDEN_THINKING_KEY = "shelleport.hidden-thinking-session-ids";

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

function usePopoverDismiss(
	open: boolean,
	setOpen: (open: boolean) => void,
	buttonRef: React.RefObject<HTMLElement | null>,
	dropdownRef: React.RefObject<HTMLElement | null>,
) {
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

		function handleKeyDown(event: KeyboardEvent) {
			if (event.key === "Escape") {
				setOpen(false);
			}
		}

		document.addEventListener("mousedown", handleClick);
		document.addEventListener("keydown", handleKeyDown);
		return () => {
			document.removeEventListener("mousedown", handleClick);
			document.removeEventListener("keydown", handleKeyDown);
		};
	}, [open, setOpen, buttonRef, dropdownRef]);
}

function InputPlusMenu({ canAttach, onAttach }: { canAttach: boolean; onAttach: () => void }) {
	return (
		<button
			type="button"
			onClick={canAttach ? onAttach : undefined}
			disabled={!canAttach}
			className="flex size-7 items-center justify-center rounded border border-foreground/10 text-muted-foreground transition hover:text-foreground hover:border-foreground/20 disabled:opacity-30"
			title="Attach files"
		>
			<Plus className="size-3.5" />
		</button>
	);
}

function InputModelPicker({
	session,
	models,
	onChangeModel,
}: {
	session: HostSession;
	models: ProviderModel[];
	onChangeModel: (model: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const buttonRef = useRef<HTMLButtonElement>(null);
	const dropdownRef = useRef<HTMLDivElement>(null);
	const [pos, setPos] = useState({ bottom: 0, left: 0 });
	usePopoverDismiss(open, setOpen, buttonRef, dropdownRef);

	const currentModel = models.find((m) => m.id === session.model);
	const label = currentModel?.label ?? friendlyModelLabel(session.model);

	function handleToggle() {
		if (!open && buttonRef.current) {
			const rect = buttonRef.current.getBoundingClientRect();
			setPos({
				bottom: window.innerHeight - rect.top + 4,
				left: rect.left,
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
				className="flex h-7 items-center gap-1 rounded border border-foreground/10 px-2 text-xs text-muted-foreground transition hover:text-foreground hover:border-foreground/20"
			>
				<span>{label}</span>
				<ChevronDown className="size-2.5" />
			</button>
			{open &&
				createPortal(
					<div
						ref={dropdownRef}
						style={{ bottom: pos.bottom, left: pos.left }}
						className="fixed z-[9999] min-w-[150px] rounded-md border border-foreground/12 bg-card p-1 shadow-lg"
					>
						{models.map((model) => (
							<button
								key={model.id}
								type="button"
								onClick={() => {
									onChangeModel(model.id);
									setOpen(false);
								}}
								className={`flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-xs text-left transition ${
									session.model === model.id
										? "bg-accent text-foreground"
										: "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
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

const EFFORT_LEVELS: { id: EffortLevel; label: string }[] = [
	{ id: "low", label: "Low" },
	{ id: "medium", label: "Med" },
	{ id: "high", label: "High" },
	{ id: "max", label: "Max" },
];

function getEffortLevels(
	modelId: string | null,
	models: ProviderModel[],
): { id: EffortLevel; label: string }[] {
	const supportedLevels = getSupportedEffortLevels(modelId, models);
	return EFFORT_LEVELS.filter((level) => supportedLevels.includes(level.id));
}

function InputEffortPicker({
	models,
	session,
	onChangeEffort,
}: {
	models: ProviderModel[];
	session: HostSession;
	onChangeEffort: (effort: EffortLevel | null) => void;
}) {
	const [open, setOpen] = useState(false);
	const buttonRef = useRef<HTMLButtonElement>(null);
	const dropdownRef = useRef<HTMLDivElement>(null);
	const [pos, setPos] = useState({ bottom: 0, left: 0 });
	usePopoverDismiss(open, setOpen, buttonRef, dropdownRef);

	const levels = getEffortLevels(session.model, models);
	if (levels.length === 0) return null;

	const effectiveEffort = session.effort ?? "medium";
	const current = levels.find((e) => e.id === effectiveEffort);
	const label = current?.label ?? "Med";

	function handleToggle() {
		if (!open && buttonRef.current) {
			const rect = buttonRef.current.getBoundingClientRect();
			setPos({
				bottom: window.innerHeight - rect.top + 4,
				left: rect.left,
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
				className="flex h-7 items-center gap-1 rounded border border-foreground/10 px-2 text-xs text-muted-foreground transition hover:text-foreground hover:border-foreground/20"
			>
				<span>{label}</span>
				<ChevronDown className="size-2.5" />
			</button>
			{open &&
				createPortal(
					<div
						ref={dropdownRef}
						style={{ bottom: pos.bottom, left: pos.left }}
						className="fixed z-[9999] min-w-[120px] rounded-md border border-foreground/12 bg-card p-1 shadow-lg"
					>
						{levels.map((level) => (
							<button
								key={level.id}
								type="button"
								onClick={() => {
									onChangeEffort(level.id);
									setOpen(false);
								}}
								className={`flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-xs text-left transition ${
									effectiveEffort === level.id
										? "bg-accent text-foreground"
										: "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
								}`}
							>
								{level.label}
							</button>
						))}
					</div>,
					document.body,
				)}
		</>
	);
}

function SidebarRunningDots() {
	return (
		<span className="inline-flex items-center gap-[3px]">
			<span className="size-[5px] animate-[sidebar-dot_1.2s_ease-in-out_0ms_infinite] rounded-full bg-emerald-400" />
			<span className="size-[5px] animate-[sidebar-dot_1.2s_ease-in-out_200ms_infinite] rounded-full bg-emerald-400" />
			<span className="size-[5px] animate-[sidebar-dot_1.2s_ease-in-out_400ms_infinite] rounded-full bg-emerald-400" />
		</span>
	);
}

function SidebarSessionMeta({ session }: { session: HostSession }) {
	const now = useNow();

	return (
		<p className="mt-0.5 ml-3.5 truncate text-xs text-muted-foreground">
			{getSidebarMeta(session, now)}
		</p>
	);
}

function downloadFile(content: string, filename: string, mimeType: string) {
	const blob = new Blob([content], { type: mimeType });
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = filename;
	document.body.appendChild(anchor);
	anchor.click();
	document.body.removeChild(anchor);
	URL.revokeObjectURL(url);
}

function sanitizeFilename(title: string) {
	return (
		title
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 60) || "session"
	);
}

function SessionStatsPopover({ badges }: { badges: SessionHeaderBadge[] }) {
	const [open, setOpen] = useState(false);
	const buttonRef = useRef<HTMLButtonElement>(null);
	const dropdownRef = useRef<HTMLDivElement>(null);
	const [pos, setPos] = useState({ top: 0, right: 8 });
	const isMobile = typeof window !== "undefined" && window.innerWidth < 768;
	usePopoverDismiss(open, setOpen, buttonRef, dropdownRef);

	function handleToggle() {
		if (!open && buttonRef.current) {
			const rect = buttonRef.current.getBoundingClientRect();
			setPos({
				top: rect.bottom + 4,
				right: isMobile ? 8 : window.innerWidth - rect.right,
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
				title="Session stats"
				className="flex items-center justify-center gap-1 rounded border border-foreground/12 px-2 py-1 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 text-xs text-muted-foreground transition hover:border-foreground/18 hover:text-foreground"
			>
				<Info className="size-3 md:size-2.5" />
				<span className="hidden md:inline">Stats</span>
			</button>
			{open &&
				createPortal(
					<div
						ref={dropdownRef}
						style={{ top: pos.top, right: pos.right, left: isMobile ? 8 : "auto" }}
						className="fixed z-[9999] min-w-[200px] max-w-[320px] rounded-md border border-foreground/12 bg-card p-3 shadow-lg"
					>
						<p className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-foreground/68">
							Session Stats
						</p>
						<div className="space-y-1.5">
							{badges.map((badge) => (
								<div key={badge.key} className="flex items-baseline justify-between gap-3">
									<span className="shrink-0 text-xs uppercase tracking-[0.08em] text-muted-foreground">
										{badge.key.split(":")[0] ?? badge.label}
									</span>
									<span className="truncate text-right text-xs tabular-nums text-foreground/90">
										{badge.label}
									</span>
								</div>
							))}
						</div>
					</div>,
					document.body,
				)}
		</>
	);
}

function FileDiffModal({
	filePath,
	diff,
	onClose,
}: {
	filePath: string;
	diff: FileEditDiff;
	onClose: () => void;
}) {
	return createPortal(
		<div
			className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm"
			onClick={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<div className="flex h-[80vh] w-[min(860px,95vw)] flex-col overflow-hidden rounded-lg border border-foreground/12 bg-card shadow-2xl">
				<div className="flex shrink-0 items-center gap-3 border-b border-foreground/10 px-4 py-3">
					<span
						className="min-w-0 flex-1 truncate font-mono text-xs text-foreground/80"
						title={filePath}
					>
						{filePath}
					</span>
					<span className="text-[10px] tabular-nums text-emerald-400/80">+{diff.added}</span>
					<span className="text-[10px] tabular-nums text-red-400/80">−{diff.removed}</span>
					<button
						type="button"
						onClick={onClose}
						className="flex size-6 items-center justify-center rounded text-foreground/50 transition hover:bg-accent/60 hover:text-foreground"
					>
						<X className="size-3.5" />
					</button>
				</div>
				<div className="flex-1 overflow-y-auto">
					<Suspense
						fallback={
							<div className="flex items-center justify-center py-12">
								<Loader2 className="size-4 animate-spin text-muted-foreground/50" />
							</div>
						}
					>
						{diff.edits.map((edit, i) => (
							<LazyEditDiff
								key={i}
								oldPath={filePath}
								oldContents={edit.oldString}
								newPath={filePath}
								newContents={edit.newString}
							/>
						))}
					</Suspense>
				</div>
			</div>
		</div>,
		document.body,
	);
}

function FileBrowserSidebar({
	rootPath,
	fileDiffs,
	onClose,
	onSelectFile,
}: {
	rootPath: string;
	fileDiffs: Map<string, FileEditDiff>;
	onClose: () => void;
	onSelectFile: (path: string) => void;
}) {
	const [currentPath, setCurrentPath] = useState(rootPath);
	const [listing, setListing] = useState<DirectoryListing | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [diffModalPath, setDiffModalPath] = useState<string | null>(null);
	const [copiedPath, setCopiedPath] = useState<string | null>(null);

	const load = useCallback(async (path: string) => {
		setLoading(true);
		setError(null);
		try {
			const result = await fetchDirectory(path);
			setListing(result);
			setCurrentPath(result.path);
		} catch {
			setError("Failed to load directory");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void load(rootPath);
	}, [rootPath, load]);

	const sorted = listing
		? [
				...listing.entries.filter((e) => e.kind === "directory"),
				...listing.entries.filter((e) => e.kind === "file"),
			]
		: [];

	const canGoUp = listing?.parentPath !== null && listing?.parentPath !== undefined;

	const displayPath = currentPath.length > 32 ? `…${currentPath.slice(-30)}` : currentPath;

	function handleCopyPath(path: string) {
		void copyToClipboard(path).then(() => {
			setCopiedPath(path);
			setTimeout(() => setCopiedPath(null), 1500);
		});
	}

	const diffModalDiff = diffModalPath ? fileDiffs.get(diffModalPath) : null;

	return (
		<div className="flex flex-col h-full overflow-hidden">
			{diffModalDiff && diffModalPath && (
				<FileDiffModal
					filePath={diffModalPath}
					diff={diffModalDiff}
					onClose={() => setDiffModalPath(null)}
				/>
			)}

			{/* Header */}
			<div className="flex items-center gap-1.5 border-b border-foreground/10 px-2 py-2 shrink-0">
				<button
					type="button"
					disabled={!canGoUp || loading}
					onClick={() => {
						if (listing?.parentPath) {
							void load(listing.parentPath);
						}
					}}
					title="Go up"
					className="flex size-6 items-center justify-center rounded text-foreground/50 transition hover:bg-accent/60 hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed"
				>
					<ChevronLeft className="size-3.5" />
				</button>
				<span
					className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground/70 font-mono"
					title={currentPath}
				>
					{displayPath}
				</span>
				<button
					type="button"
					onClick={onClose}
					title="Close file browser"
					className="flex size-6 items-center justify-center rounded text-foreground/50 transition hover:bg-accent/60 hover:text-foreground"
				>
					<X className="size-3.5" />
				</button>
			</div>

			{/* Content */}
			<div className="flex-1 overflow-y-auto py-1">
				{loading && (
					<div className="flex items-center justify-center py-8">
						<Loader2 className="size-4 animate-spin text-muted-foreground/50" />
					</div>
				)}
				{error && !loading && <p className="px-3 py-4 text-xs text-destructive/70">{error}</p>}
				{!loading && !error && sorted.length === 0 && (
					<p className="px-3 py-4 text-xs text-muted-foreground/50">Empty directory</p>
				)}
				{!loading &&
					!error &&
					sorted.map((entry) => {
						const diff = entry.kind === "file" ? fileDiffs.get(entry.path) : null;
						const isCopied = copiedPath === entry.path;
						return (
							<div key={entry.path} className="group flex items-center hover:bg-accent/60">
								<button
									type="button"
									onClick={() => {
										if (entry.kind === "directory") {
											void load(entry.path);
										} else {
											onSelectFile(entry.path);
										}
									}}
									className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5 text-left text-xs"
								>
									{entry.kind === "directory" ? (
										<Folder className="size-3.5 shrink-0 text-muted-foreground/60" />
									) : (
										<File className="size-3.5 shrink-0 text-muted-foreground/40" />
									)}
									<span className="min-w-0 flex-1 truncate text-foreground/80">{entry.name}</span>
								</button>
								{diff && (
									<button
										type="button"
										onClick={() => setDiffModalPath(entry.path)}
										title="View diff"
										className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] tabular-nums transition hover:bg-accent"
									>
										<span className="text-emerald-400/80">+{diff.added}</span>
										<span className="text-red-400/80">−{diff.removed}</span>
									</button>
								)}
								<button
									type="button"
									onClick={() => handleCopyPath(entry.path)}
									title="Copy path"
									className="mr-1.5 flex size-5 shrink-0 items-center justify-center rounded text-foreground/30 opacity-0 transition hover:bg-accent hover:text-foreground group-hover:opacity-100"
								>
									{isCopied ? <Check className="size-3" /> : <ClipboardCopy className="size-3" />}
								</button>
							</div>
						);
					})}
			</div>
		</div>
	);
}

function SessionActionsPopover({
	session,
	projects,
	stream,
	copiedConversation,
	hideThinking,
	fileBrowserOpen,
	onPin,
	onRename,
	onCopy,
	onMoveProject,
	onToggleThinking,
	onToggleFileBrowser,
	onExportMarkdown,
	onExportJson,
	onArchive,
	canEditSystemPrompt,
	onEditSystemPrompt,
}: {
	session: HostSession;
	projects: Project[];
	stream: HostEvent[];
	copiedConversation: boolean;
	hideThinking: boolean;
	fileBrowserOpen: boolean;
	onPin: (id: string, pinned: boolean) => void;
	onRename: () => void;
	onCopy: () => void;
	onMoveProject: (projectId: string | null) => void;
	onToggleThinking: () => void;
	onToggleFileBrowser: () => void;
	onExportMarkdown: () => void;
	onExportJson: () => void;
	onArchive: (id: string, archived: boolean) => void;
	canEditSystemPrompt: boolean;
	onEditSystemPrompt: () => void;
}) {
	const [open, setOpen] = useState(false);
	const buttonRef = useRef<HTMLButtonElement>(null);
	const dropdownRef = useRef<HTMLDivElement>(null);
	const [pos, setPos] = useState({ top: 0, right: 8 });
	const isMobile = typeof window !== "undefined" && window.innerWidth < 768;

	usePopoverDismiss(open, setOpen, buttonRef, dropdownRef);

	function handleToggle() {
		if (!open && buttonRef.current) {
			const rect = buttonRef.current.getBoundingClientRect();
			setPos({
				top: rect.bottom + 4,
				right: isMobile ? 8 : window.innerWidth - rect.right,
			});
		}

		setOpen(!open);
	}

	const actionItems = (
		<>
			<button
				type="button"
				onClick={() => {
					onPin(session.id, !session.pinned);
					setOpen(false);
				}}
				className="flex w-full items-center gap-2.5 rounded px-2.5 py-2 text-xs text-left transition text-muted-foreground hover:bg-accent/60 hover:text-foreground"
			>
				<Pin className="size-3.5" />
				{session.pinned ? "Unpin" : "Pin"}
			</button>
			<button
				type="button"
				onClick={() => {
					onArchive(session.id, !session.archived);
					setOpen(false);
				}}
				className="flex w-full items-center gap-2.5 rounded px-2.5 py-2 text-xs text-left transition text-muted-foreground hover:bg-accent/60 hover:text-foreground"
			>
				{session.archived ? (
					<ArchiveRestore className="size-3.5" />
				) : (
					<Archive className="size-3.5" />
				)}
				{session.archived ? "Unarchive" : "Archive"}
			</button>
			<button
				type="button"
				onClick={() => {
					onRename();
					setOpen(false);
				}}
				className="flex w-full items-center gap-2.5 rounded px-2.5 py-2 text-xs text-left transition text-muted-foreground hover:bg-accent/60 hover:text-foreground"
			>
				<Pencil className="size-3.5" />
				Rename
			</button>
			{canEditSystemPrompt && (
				<button
					type="button"
					onClick={() => {
						onEditSystemPrompt();
						setOpen(false);
					}}
					className="flex w-full items-center gap-2.5 rounded px-2.5 py-2 text-xs text-left transition text-muted-foreground hover:bg-accent/60 hover:text-foreground"
				>
					<FileText className="size-3.5" />
					{session.systemPrompt ? "Edit system prompt" : "Add system prompt"}
				</button>
			)}
			<button
				type="button"
				onClick={() => {
					onToggleThinking();
					setOpen(false);
				}}
				className="flex w-full items-center gap-2.5 rounded px-2.5 py-2 text-xs text-left transition text-muted-foreground hover:bg-accent/60 hover:text-foreground"
			>
				{hideThinking ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
				{hideThinking ? "Show thinking" : "Hide thinking"}
			</button>
			{!isMobile && (
				<button
					type="button"
					onClick={() => {
						onToggleFileBrowser();
						setOpen(false);
					}}
					className="flex w-full items-center gap-2.5 rounded px-2.5 py-2 text-xs text-left transition text-muted-foreground hover:bg-accent/60 hover:text-foreground"
				>
					<FolderTree className="size-3.5" />
					{fileBrowserOpen ? "Close file browser" : "Browse files"}
				</button>
			)}
			{stream.length > 0 && (
				<>
					<div className="my-1 border-t border-foreground/8" />
					<p className="px-2.5 py-1 text-xs uppercase tracking-[0.12em] text-muted-foreground">
						Export
					</p>
					<button
						type="button"
						onClick={() => {
							onCopy();
							setOpen(false);
						}}
						className="flex w-full items-center gap-2.5 rounded px-2.5 py-2 text-xs text-left transition text-muted-foreground hover:bg-accent/60 hover:text-foreground"
					>
						{copiedConversation ? (
							<Check className="size-3.5" />
						) : (
							<ClipboardCopy className="size-3.5" />
						)}
						{copiedConversation ? "Copied" : "Copy to clipboard"}
					</button>
					<button
						type="button"
						onClick={() => {
							onExportMarkdown();
							setOpen(false);
						}}
						className="flex w-full items-center gap-2.5 rounded px-2.5 py-2 text-xs text-left transition text-muted-foreground hover:bg-accent/60 hover:text-foreground"
					>
						<FileDown className="size-3.5" />
						Export as Markdown
					</button>
					<button
						type="button"
						onClick={() => {
							onExportJson();
							setOpen(false);
						}}
						className="flex w-full items-center gap-2.5 rounded px-2.5 py-2 text-xs text-left transition text-muted-foreground hover:bg-accent/60 hover:text-foreground"
					>
						<FileDown className="size-3.5" />
						Export as JSON
					</button>
				</>
			)}
			{projects.length > 0 && (
				<>
					<div className="my-1 border-t border-foreground/8" />
					<p className="px-2.5 py-1 text-xs uppercase tracking-[0.12em] text-muted-foreground">
						Move to project
					</p>
					<button
						type="button"
						onClick={() => {
							onMoveProject(null);
							setOpen(false);
						}}
						className={`flex w-full items-center gap-2.5 rounded px-2.5 py-1.5 text-xs text-left transition ${
							session.projectId === null
								? "bg-accent text-foreground"
								: "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
						}`}
					>
						None
					</button>
					{projects.map((project) => (
						<button
							key={project.id}
							type="button"
							onClick={() => {
								onMoveProject(project.id);
								setOpen(false);
							}}
							className={`flex w-full items-center gap-2.5 rounded px-2.5 py-1.5 text-xs text-left transition ${
								session.projectId === project.id
									? "bg-accent text-foreground"
									: "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
							}`}
						>
							<Folder className="size-3" />
							{project.name}
						</button>
					))}
				</>
			)}
		</>
	);

	return (
		<>
			<button
				ref={buttonRef}
				type="button"
				onClick={handleToggle}
				title="Actions"
				className="flex items-center justify-center gap-1 rounded border border-foreground/12 px-2 py-1 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 text-xs text-foreground/60 transition hover:border-foreground/18 hover:text-foreground"
			>
				<EllipsisVertical className="size-4 md:size-3.5" />
			</button>
			{isMobile ? (
				<Sheet open={open} onOpenChange={setOpen}>
					<SheetContent
						side="bottom"
						showCloseButton={false}
						className="rounded-t-3xl border-x-0 border-b-0 border-t border-foreground/12 bg-card px-0 pt-2 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] shadow-2xl"
					>
						<SheetTitle className="sr-only">Session actions</SheetTitle>
						<div className="mx-auto mb-2 h-1.5 w-10 rounded-full bg-foreground/15" />
						<div className="max-h-[70dvh] overflow-y-auto px-3 pb-2">{actionItems}</div>
					</SheetContent>
				</Sheet>
			) : (
				open &&
				createPortal(
					<div
						ref={dropdownRef}
						style={{ top: pos.top, right: pos.right, left: isMobile ? 8 : "auto" }}
						className="fixed z-[9999] min-w-[180px] max-w-[260px] rounded-md border border-foreground/12 bg-card p-1 shadow-lg"
					>
						{actionItems}
					</div>,
					document.body,
				)
			)}
		</>
	);
}

function SidebarSessionItem({
	candidate,
	selectedId,
	navigate,
	setSidebarOpen,
}: {
	candidate: HostSession;
	selectedId: string | null;
	navigate: (path: string) => void;
	setSidebarOpen: (open: boolean) => void;
}) {
	return (
		<div
			key={candidate.id}
			className={`group flex items-center gap-1 rounded-md transition ${
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
					<span className="line-clamp-1 min-w-0 flex-1 text-xs">{candidate.title}</span>
					{candidate.status === "failed" && (
						<CircleX className="shrink-0 text-destructive/70 size-3" />
					)}
				</div>
				<SidebarSessionMeta session={candidate} />
			</button>
			{isActiveStatus(candidate.status) && (
				<div className="shrink-0 pr-2">
					<SidebarRunningDots />
				</div>
			)}
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
			<div className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
				Claude limits
			</div>
			<div className="space-y-3.5">
				{limits.map((limit) => (
					<div key={limit.window ?? "unknown"} className="text-xs">
						<div className="mb-1.5 flex items-baseline justify-between gap-2">
							<span className="font-medium text-foreground/90">
								{formatSessionLimitLabel(limit.window ?? "")}
							</span>
							<span className="tabular-nums text-muted-foreground">
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
						<div className="mt-1.5 text-xs text-muted-foreground">
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
		<div className="mb-3 hidden flex-wrap items-center justify-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground md:flex">
			{SIDEBAR_SHORTCUTS.map((shortcut) => (
				<span key={shortcut.key} className="inline-flex items-center gap-1">
					<kbd className="rounded border border-foreground/14 bg-background/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
						{shortcut.key}
					</kbd>
					{shortcut.label}
				</span>
			))}
		</div>
	);
}

function SessionStatusBadge({
	session,
	reconnecting,
}: {
	session: HostSession;
	reconnecting?: boolean;
}) {
	const now = useNow();
	const modelLabel = session.model ? friendlyModelLabel(session.model) : null;
	const effortLabel = session.effort
		? session.effort.charAt(0).toUpperCase() + session.effort.slice(1)
		: null;

	if (reconnecting) {
		return (
			<div className="flex min-h-[44px] min-w-[44px] items-center justify-center gap-1.5 rounded border border-amber-500/25 bg-amber-500/8 px-0 py-1 md:min-h-0 md:min-w-0 md:px-2">
				<Loader2 className="size-2.5 animate-spin text-amber-400/80" />
				<span className="hidden md:inline text-xs text-amber-300/80">Reconnecting…</span>
			</div>
		);
	}

	const isActive = session.status === "running" || session.status === "retrying";

	return (
		<div
			className={`flex min-h-[44px] min-w-[44px] items-center justify-center gap-1.5 rounded border px-0 py-1 md:min-h-0 md:min-w-0 md:px-2 ${
				isActive ? "border-emerald-500/25 bg-emerald-500/8" : "border-foreground/12"
			}`}
		>
			<StatusDot status={session.status} />
			<span
				className={`hidden md:inline text-xs ${
					isActive ? "text-emerald-300" : "text-muted-foreground"
				}`}
			>
				{formatStatus(session, now)}
			</span>
			{modelLabel && (
				<>
					<span className="hidden md:inline text-foreground/20">·</span>
					<span className="hidden md:inline text-xs text-muted-foreground">{modelLabel}</span>
				</>
			)}
			{effortLabel && (
				<>
					<span className="hidden md:inline text-foreground/20">·</span>
					<span className="hidden md:inline text-xs text-muted-foreground">{effortLabel}</span>
				</>
			)}
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

function getComposerPlaceholder(providerLabel: string, isBusy: boolean, canAttach: boolean) {
	if (isBusy) {
		return `${providerLabel} is working... press Enter to queue`;
	}

	if (canAttach) {
		return `Message ${providerLabel}... attach files or paste images`;
	}

	return `Message ${providerLabel}... (Enter to send)`;
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
	const [projects, setProjects] = useState<Project[]>(boot.projects);
	const [sessions, setSessions] = useState<HostSession[]>(boot.sessions);
	const [detailSessionId, setDetailSessionId] = useState<string | null>(
		initialDetail?.session.id ?? null,
	);
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
	const [streamState, setStreamState] = useState<"connected" | "reconnecting">("connected");
	const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [copiedConversation, setCopiedConversation] = useState(false);
	const [hiddenThinkingSessionIds, setHiddenThinkingSessionIds] = useState<string[]>(() => {
		try {
			const stored = window.localStorage.getItem(HIDDEN_THINKING_KEY);
			return stored ? (JSON.parse(stored) as string[]) : [];
		} catch {
			return [];
		}
	});
	const [fileBrowserOpen, setFileBrowserOpen] = useState(false);
	const [renameState, setRenameState] = useState<{ sessionId: string; title: string } | null>(null);
	const [systemPromptEdit, setSystemPromptEdit] = useState<{
		sessionId: string;
		systemPrompt: string;
	} | null>(null);
	const [sidebarOpen, setSidebarOpen] = useState(false);
	const [sessionQuery, setSessionQuery] = useState("");
	const [deleteProjectConfirmId, setDeleteProjectConfirmId] = useState<string | null>(null);
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
	const sessionView = selectedSession;
	const hideThinking = !selectedId || hiddenThinkingSessionIds.includes(selectedId);
	const [voiceState, setVoiceState] = useState<VoiceInputState>({ status: "idle" });
	const voiceSetupRef = useRef<ReturnType<typeof createVoiceSession> | null>(null);
	const voiceSessionRef =
		useRef<Awaited<ReturnType<ReturnType<typeof createVoiceSession>["start"]>>>(null);
	const voiceStateUpdatesEnabledRef = useRef(true);
	const hasSelectedSessionDetail = selectedId !== null && detailSessionId === selectedId;
	const isSessionPending = isSessionRoute && (sessionView === null || !hasSelectedSessionDetail);
	const sessionStream = hasSelectedSessionDetail ? stream : [];
	const sessionTotalEvents = hasSelectedSessionDetail ? totalEvents : 0;
	const sessionPendingRequests = hasSelectedSessionDetail ? pendingRequests : [];
	const sessionQueuedInputs = hasSelectedSessionDetail ? queuedInputs : [];
	const { activeSessions, archivedSessions, projectGroups } = useMemo(() => {
		const active: HostSession[] = [];
		const archived: HostSession[] = [];

		for (const candidate of sessions) {
			if (candidate.archived) {
				archived.push(candidate);
				continue;
			}

			active.push(candidate);
		}

		// Group active sessions by projectId
		const groupMap = new Map<string | null, HostSession[]>();
		for (const session of active) {
			const key = session.projectId ?? null;
			if (!groupMap.has(key)) {
				groupMap.set(key, []);
			}
			groupMap.get(key)!.push(session);
		}

		// Create groups: named projects first (sorted by name), then ungrouped
		const groups: Array<{
			projectId: string | null;
			projectName: string | null;
			sessions: HostSession[];
		}> = [];

		// Add named projects first (sorted by name)
		const namedProjects = projects
			.filter((p) => p.id !== null)
			.sort((a, b) => a.name.localeCompare(b.name));
		for (const project of namedProjects) {
			const sessions = groupMap.get(project.id) ?? [];
			if (sessions.length > 0) {
				groups.push({
					projectId: project.id,
					projectName: project.name,
					sessions,
				});
			}
		}

		// Add ungrouped sessions
		const ungrouped = groupMap.get(null) ?? [];
		if (ungrouped.length > 0) {
			groups.push({
				projectId: null,
				projectName: null,
				sessions: ungrouped,
			});
		}

		return {
			activeSessions: active,
			archivedSessions: archived,
			projectGroups: groups,
		};
	}, [sessions, projects]);
	const fileDiffs = useMemo(() => getStreamEditDiffs(sessionStream), [sessionStream]);

	const grouped = useMemo(() => {
		const groups = groupStream(sessionStream);
		if (!hideThinking) return groups;
		return groups.filter(
			(group) =>
				!(
					group.type === "single" &&
					group.entry.kind === "text" &&
					group.entry.data.role === "thinking"
				),
		);
	}, [sessionStream, hideThinking]);
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
	const [createProviderId, setCreateProviderId] = useState<ProviderId | null>(null);
	useEffect(() => {
		setCreateProviderId((current) => {
			if (current && creatableProviders.some((provider) => provider.id === current)) {
				return current;
			}

			return creatableProviders[0]?.id ?? null;
		});
	}, [creatableProviders]);
	const createProvider =
		(createProviderId
			? creatableProviders.find((provider) => provider.id === createProviderId)
			: null) ??
		creatableProviders[0] ??
		null;
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
	const isEditingSystemPrompt =
		systemPromptEdit !== null && systemPromptEdit.sessionId === sessionView?.id;
	const systemPromptDraft = isEditingSystemPrompt ? systemPromptEdit.systemPrompt : "";
	const editingQueuedInputId = queuedInputEdit?.id ?? null;
	const queuedInputDraft = queuedInputEdit?.prompt ?? "";
	const isVoiceBusy = voiceState.status === "loading-model" || voiceState.status === "transcribing";
	const activeVoiceSession = voiceState.status === "recording" ? voiceSessionRef.current : null;
	const isVoiceRecording = activeVoiceSession !== null;

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

	function applyVoiceState(nextState: VoiceInputState) {
		if (voiceStateUpdatesEnabledRef.current) {
			setVoiceState(nextState);
		}
	}

	function cancelVoiceInput(resetState = true) {
		const voiceSetup = voiceSetupRef.current;
		voiceSetupRef.current = null;
		voiceSetup?.cancelSetup();

		const voiceSession = voiceSessionRef.current;
		voiceSessionRef.current = null;
		voiceSession?.cancel();

		if (resetState && !voiceSetup && !voiceSession) {
			setVoiceState({ status: "idle" });
		}
	}

	function resetSessionViewState() {
		cancelVoiceInput();
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
		void fetchProviders()
			.then(({ providers: nextProviders }) => setProviders(nextProviders))
			.catch(() => {});
	}, []);

	useEffect(() => {
		void refreshSessions(deferredSessionQuery).catch(() => {});
	}, [deferredSessionQuery, refreshSessions]);

	useEffect(() => {
		if (!hasRunningSession) return;

		const interval = setInterval(() => {
			void refreshSessions(deferredSessionQuery).catch(() => {});
		}, 3000);

		return () => clearInterval(interval);
	}, [hasRunningSession, deferredSessionQuery, refreshSessions]);

	useEffect(() => {
		resetSessionViewState();

		if (selectedId) {
			requestNotificationPermission();
		}

		setFileBrowserOpen(false);
	}, [selectedId]);

	useEffect(() => {
		if (voiceState.status === "error") {
			showToast("error", voiceState.message);
			setVoiceState({ status: "idle" });
		}
	}, [voiceState, showToast]);

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
						setDetailSessionId(message.payload.session.id);
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

						setDetailSessionId(message.payload.id);
						if (message.payload.status !== "waiting") {
							setPendingRequests([]);
						}
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
			(state) => {
				if (state === "connected") {
					if (reconnectTimerRef.current) {
						clearTimeout(reconnectTimerRef.current);
						reconnectTimerRef.current = null;
					}
					setStreamState("connected");
				} else {
					// Delay showing "reconnecting" — fast reconnects (proxy timeouts, heartbeat cycles)
					// resolve before the timer fires and the user never sees the indicator.
					if (!reconnectTimerRef.current) {
						reconnectTimerRef.current = setTimeout(() => {
							reconnectTimerRef.current = null;
							setStreamState("reconnecting");
						}, 3000);
					}
				}
			},
		);

		return () => {
			if (reconnectTimerRef.current) {
				clearTimeout(reconnectTimerRef.current);
				reconnectTimerRef.current = null;
			}

			controller.abort();
		};
	}, [replaceSession, selectedId]);

	useEffect(() => {
		document.title = getDocumentTitle(sessionView);

		return () => {
			document.title = "shelleport";
		};
	}, [sessionView?.id, sessionView?.status, sessionView?.title]);

	useEffect(() => {
		return () => {
			voiceStateUpdatesEnabledRef.current = false;
			cancelVoiceInput(false);

			for (const attachment of draftAttachmentsRef.current) {
				releaseDraftAttachment(attachment);
			}
		};
	}, []);

	const handleCreateSession = useCallback(
		async (input: {
			cwd: string;
			title: string;
			permissionMode: PermissionMode;
			model?: string;
			effort?: EffortLevel | null;
			systemPrompt?: string;
			projectId?: string;
		}) => {
			if (!input.cwd.trim() || !createProvider) {
				return;
			}

			setIsCreating(true);

			try {
				const result = await createSession({
					provider: createProvider.id,
					cwd: input.cwd.trim(),
					permissionMode: input.permissionMode,
					title: input.title || undefined,
					model: input.model,
					effort: input.effort ?? undefined,
					systemPrompt: input.systemPrompt,
					projectId: input.projectId,
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

	async function handleVoiceRecord() {
		if (voiceState.status === "recording" && voiceSessionRef.current) {
			const text = await voiceSessionRef.current.stop();
			voiceSessionRef.current = null;
			if (text) {
				setPrompt((previous) => (previous ? `${previous} ${text}` : text));
			}
			return;
		}

		if (voiceState.status !== "idle") return;

		const voiceSetup = createVoiceSession({ onStateChange: applyVoiceState });
		voiceSetupRef.current = voiceSetup;
		const recorder = await voiceSetup.start();
		if (voiceSetupRef.current !== voiceSetup) {
			return;
		}
		voiceSetupRef.current = null;
		if (recorder) {
			voiceSessionRef.current = recorder;
		}
	}

	function handleVoiceCancel() {
		cancelVoiceInput();
	}

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
				replaceSession(result.session);

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
		[
			isArchivedView,
			navigate,
			refreshSessions,
			replaceSession,
			selectedId,
			sessionQuery,
			showToast,
		],
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

	const handleDeleteProject = useCallback(
		async (projectId: string) => {
			try {
				await deleteProjectApi(projectId);
				setProjects((previous) => previous.filter((p) => p.id !== projectId));
				setSessions((previous) =>
					previous.map((session) =>
						session.projectId === projectId ? { ...session, projectId: null } : session,
					),
				);
				setDeleteProjectConfirmId(null);
			} catch {
				showToast("error", "Failed to delete project");
			}
		},
		[showToast],
	);

	const handleCopyConversation = useCallback(() => {
		void copyToClipboard(streamToMarkdown(sessionStream)).then(() => {
			setCopiedConversation(true);
			setTimeout(() => setCopiedConversation(false), 2000);
		});
	}, [sessionStream]);

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
			const previousPendingRequests = sessionPendingRequests;
			setPendingRequests((previous) => previous.filter((request) => request.id !== requestId));
			try {
				await respondToRequest(requestId, payload);
			} catch {
				setPendingRequests(previousPendingRequests);
				showToast("error", "Failed to respond to request");
			}
		},
		[sessionPendingRequests, showToast],
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
			replaceSession(result.session);
			return result.session;
		},
		[refreshSessions, replaceSession, sessionQuery],
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

	const handleMoveSessionToProject = useCallback(
		async (projectId: string | null) => {
			if (!selectedId) return;
			try {
				const result = await updateSessionMeta(selectedId, { projectId });
				replaceSession(result.session);
				await refreshSessions(sessionQuery);
			} catch {
				showToast("error", "Failed to move session to project");
			}
		},
		[selectedId, refreshSessions, replaceSession, sessionQuery, showToast],
	);

	const handleChangeModel = useCallback(
		async (session: HostSession, model: string, models: ProviderModel[]) => {
			const effort =
				normalizeEffortLevel(model, session.effort, models) ?? getDefaultEffortLevel(model, models);

			try {
				await applySessionMetaUpdate(
					session.id,
					effort === session.effort ? { model } : { model, effort },
				);
				writeLastSessionPreferences(model, effort, models);
			} catch {
				showToast("error", "Failed to update model");
			}
		},
		[applySessionMetaUpdate, showToast],
	);

	const handleChangeEffort = useCallback(
		async (session: HostSession, effort: EffortLevel | null, models: ProviderModel[]) => {
			try {
				await applySessionMetaUpdate(session.id, { effort });
				writeLastSessionPreferences(session.model, effort, models);
			} catch {
				showToast("error", "Failed to update effort");
			}
		},
		[applySessionMetaUpdate, showToast],
	);

	const handleRename = useCallback(async () => {
		if (!sessionView || !isRenaming) {
			return;
		}

		const title = renameDraft.trim();

		if (title.length === 0 || title === sessionView.title) {
			setRenameState(null);
			return;
		}

		try {
			await applySessionMetaUpdate(sessionView.id, { title });
			setRenameState(null);
		} catch {
			showToast("error", "Failed to rename session");
		}
	}, [applySessionMetaUpdate, isRenaming, renameDraft, sessionView, showToast]);

	const handleSaveSystemPrompt = useCallback(async () => {
		if (!sessionView || !isEditingSystemPrompt) {
			return;
		}

		const nextPrompt = systemPromptDraft.trim() || null;

		if (nextPrompt === (sessionView.systemPrompt ?? null)) {
			setSystemPromptEdit(null);
			return;
		}

		try {
			await applySessionMetaUpdate(sessionView.id, { systemPrompt: nextPrompt });
			setSystemPromptEdit(null);
		} catch {
			showToast("error", "Failed to update system prompt");
		}
	}, [applySessionMetaUpdate, isEditingSystemPrompt, sessionView, showToast, systemPromptDraft]);

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
	const sessionProviderLabel = sessionProvider?.label ?? "Agent";
	const canAttach = sessionProvider?.capabilities.supportsAttachments === true;
	const isSessionBusy =
		sessionView?.status === "running" ||
		sessionView?.status === "retrying" ||
		sessionView?.status === "waiting";
	const queuedInputCount = sessionQueuedInputs.length;
	const canSend = !!selectedId && (prompt.trim().length > 0 || draftAttachments.length > 0);
	const permissionModeLabel = sessionView ? formatPermissionModeLabel(sessionView) : null;
	const showReconnectIndicator = shouldShowReconnectIndicator(isSessionPending, streamState);
	const statusMessage = sessionView ? getStatusMessage(sessionView) : null;
	const firstRunReadiness = getFirstRunReadiness(providers);
	const managedProviders = useMemo(
		() => providers.filter((provider) => provider.capabilities.canCreate),
		[providers],
	);

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
						<div className="text-xs font-semibold uppercase tracking-[0.16em] text-foreground/56">
							Claude setup
						</div>
						<DialogTitle className="text-xl font-medium tracking-[-0.04em] text-foreground">
							Bypass permissions should stay on.
						</DialogTitle>
						<DialogDescription className="text-[12px] leading-[1.7] text-muted-foreground">
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
			{/* System prompt edit modal */}
			<Dialog
				open={isEditingSystemPrompt}
				onOpenChange={(open) => {
					if (!open) {
						setSystemPromptEdit(null);
					}
				}}
			>
				<DialogContent showCloseButton={false} className="max-w-xl border-foreground/14 bg-card">
					<DialogHeader className="text-left">
						<DialogTitle className="text-sm font-medium tracking-[-0.02em] text-foreground">
							System prompt
						</DialogTitle>
						<DialogDescription className="text-[11px] leading-[1.6] text-muted-foreground">
							Appended to the default system prompt on every turn. Clear to remove.
						</DialogDescription>
					</DialogHeader>
					<textarea
						value={systemPromptDraft}
						onChange={(event) =>
							setSystemPromptEdit((current) =>
								current ? { ...current, systemPrompt: event.target.value } : null,
							)
						}
						rows={6}
						maxLength={10000}
						autoFocus
						placeholder="Custom instructions for this session…"
						className="w-full resize-y rounded-md border border-foreground/10 bg-background/55 px-3 py-2.5 text-xs leading-[1.7] text-foreground outline-none transition placeholder:text-muted-foreground focus-visible:border-foreground/22 focus-visible:ring-1 focus-visible:ring-foreground/14"
					/>
					<DialogFooter className="gap-2">
						<button
							type="button"
							onClick={() => setSystemPromptEdit(null)}
							className="inline-flex h-8 items-center justify-center rounded-md border border-foreground/10 px-3 text-xs font-medium text-foreground/80 transition hover:bg-accent"
						>
							Cancel
						</button>
						<button
							type="button"
							onClick={() => void handleSaveSystemPrompt()}
							className="inline-flex h-8 items-center justify-center rounded-md bg-foreground px-3 text-xs font-medium text-background transition hover:bg-foreground/90"
						>
							Save
						</button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
			{/* Sidebar content — shared between desktop aside and mobile Sheet */}
			{(() => {
				const sidebarContent = (
					<>
						<div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
							<span className="text-xs font-semibold uppercase tracking-[0.15em] text-foreground/82">
								🐚 shelleport
							</span>
							<button
								type="button"
								onClick={() => {
									navigate("/");
									setSidebarOpen(false);
								}}
								className="flex size-10 md:size-6 items-center justify-center rounded text-foreground/50 transition hover:bg-accent hover:text-foreground"
								title="New session"
							>
								<Plus className="size-4" />
							</button>
						</div>

						<div className="flex-1 overflow-y-auto px-3 py-3">
							<div className="mb-3">
								<div className="relative">
									<Search className="pointer-events-none absolute top-1/2 left-2.5 size-3 -translate-y-1/2 text-muted-foreground" />
									<input
										value={sessionQuery}
										onChange={(event) => setSessionQuery(event.target.value)}
										placeholder="Search chats"
										className="h-10 md:h-8 w-full rounded-md border border-foreground/10 bg-background/40 pr-2 pl-7 text-xs text-foreground outline-none transition placeholder:text-muted-foreground focus:border-foreground/18"
									/>
								</div>
							</div>
							{activeSessions.length === 0 ? (
								(() => {
									const emptyState = getSessionListEmptyState(sessionQuery);

									return (
										<div className="py-8 text-center">
											<p className="text-xs text-muted-foreground">{emptyState.message}</p>
											{emptyState.actionLabel && (
												<button
													type="button"
													onClick={() => {
														navigate("/");
														setSidebarOpen(false);
													}}
													className="mt-2 text-xs text-foreground/68 transition hover:text-foreground"
												>
													{emptyState.actionLabel}
												</button>
											)}
										</div>
									);
								})()
							) : (
								<div className="space-y-1">
									{projectGroups.map((group) => (
										<div key={group.projectId ?? "ungrouped"}>
											{group.projectName && (
												<div className="flex items-center justify-between gap-2 px-2.5 py-2 mb-1">
													<div className="flex items-center gap-1.5">
														<Folder className="size-3 text-muted-foreground" />
														<span className="text-xs font-medium text-muted-foreground">
															{group.projectName}
														</span>
														<span className="text-xs text-muted-foreground">
															{group.sessions.length}
														</span>
													</div>
													{deleteProjectConfirmId === group.projectId ? (
														<div className="flex items-center gap-1">
															<span className="text-xs text-destructive">
																{group.sessions.length > 0
																	? `${group.sessions.length} session${group.sessions.length === 1 ? "" : "s"} will be ungrouped. Delete?`
																	: "Delete?"}
															</span>
															<button
																type="button"
																onClick={() => void handleDeleteProject(group.projectId!)}
																className="rounded bg-destructive/15 px-1.5 py-0.5 text-xs font-medium text-destructive transition hover:bg-destructive/25"
															>
																Yes
															</button>
															<button
																type="button"
																onClick={() => setDeleteProjectConfirmId(null)}
																className="rounded bg-foreground/8 px-1.5 py-0.5 text-xs font-medium text-muted-foreground transition hover:bg-foreground/15"
															>
																No
															</button>
														</div>
													) : (
														<button
															type="button"
															onClick={() => setDeleteProjectConfirmId(group.projectId!)}
															className="flex size-5 items-center justify-center rounded text-muted-foreground transition hover:text-destructive"
															title="Delete project"
														>
															<Trash2 className="size-3" />
														</button>
													)}
												</div>
											)}
											<div className={group.projectName ? "ml-3 space-y-1" : "space-y-1"}>
												{group.sessions.map((candidate) => (
													<SidebarSessionItem
														key={candidate.id}
														candidate={candidate}
														selectedId={selectedId}
														navigate={navigate}
														setSidebarOpen={setSidebarOpen}
													/>
												))}
											</div>
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
								className={`mb-1 flex w-full items-center gap-2 rounded-md px-2.5 py-3 md:py-2 text-xs transition ${
									isArchivedView
										? "bg-accent text-foreground"
										: "text-muted-foreground hover:bg-accent hover:text-foreground"
								}`}
							>
								<Archive className="size-3" />
								Archived
								<span className="ml-auto text-xs text-muted-foreground">
									{archivedSessions.length}
								</span>
							</button>
							<button
								type="button"
								onClick={handleLogout}
								className="flex w-full items-center gap-2 rounded-md px-2.5 py-3 md:py-2 text-xs text-muted-foreground transition hover:bg-accent hover:text-foreground"
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

			{/* File browser sidebar (desktop only) */}
			{fileBrowserOpen && sessionView && (
				<aside className="hidden md:flex w-56 shrink-0 flex-col border-r border-foreground/10 bg-card/40">
					<FileBrowserSidebar
						rootPath={sessionView.cwd}
						fileDiffs={fileDiffs}
						onClose={() => setFileBrowserOpen(false)}
						onSelectFile={(path) => {
							setPrompt((prev) => (prev ? `${prev} ${path}` : path));
						}}
					/>
				</aside>
			)}

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
								<span className="text-xs text-muted-foreground">
									Restore a thread to move it back into the main list.
								</span>
							</div>
						</header>
						<div className="flex-1 overflow-y-auto px-3 md:px-6 py-4 md:py-6">
							<div className="mx-auto max-w-[70rem]">
								{archivedSessions.length === 0 ? (
									<div className="flex h-full min-h-48 items-center justify-center">
										<p className="text-xs text-muted-foreground">No archived sessions</p>
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
													<p className="mt-1 truncate text-xs text-muted-foreground">
														{archivedSession.cwd}
													</p>
												</div>
												<div className="flex shrink-0 items-center gap-2 self-end sm:self-auto">
													<button
														type="button"
														onClick={() => navigate(`/sessions/${archivedSession.id}`)}
														className="rounded border border-foreground/10 px-3 py-2.5 md:py-1.5 text-xs text-muted-foreground transition hover:border-foreground/18 hover:text-foreground"
													>
														Open
													</button>
													<button
														type="button"
														onClick={() => handleArchive(archivedSession.id, false)}
														className="flex items-center gap-1.5 rounded bg-foreground px-3 py-2.5 md:py-1.5 text-xs font-medium text-background transition hover:bg-foreground/90"
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
														className={`flex items-center gap-1.5 rounded border px-3 py-2.5 md:py-1.5 text-xs transition ${
															deleteConfirmId === archivedSession.id
																? "border-destructive/40 bg-destructive/10 text-destructive"
																: "border-foreground/10 text-muted-foreground hover:border-destructive/30 hover:text-destructive"
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
						<header className="shrink-0 bg-background/72 px-3 md:px-5 py-2.5 backdrop-blur-sm">
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
												className="flex size-6 items-center justify-center rounded border border-foreground/10 text-muted-foreground transition hover:border-foreground/18 hover:text-foreground"
												title="Save title"
											>
												<Check className="size-3" />
											</button>
											<button
												type="button"
												onClick={() => {
													setRenameState(null);
												}}
												className="flex size-6 items-center justify-center rounded border border-foreground/10 text-muted-foreground transition hover:border-foreground/18 hover:text-foreground"
												title="Cancel rename"
											>
												<X className="size-3" />
											</button>
										</div>
									) : sessionView ? (
										<h1 className="truncate text-xs font-medium text-foreground">
											{sessionView.title}
										</h1>
									) : (
										<h1 className="truncate text-xs font-medium text-foreground">
											Loading session
										</h1>
									)}
								</div>
								<div className="flex shrink-0 items-center gap-1.5">
									{sessionView && (
										<SessionStatusBadge
											session={sessionView}
											reconnecting={showReconnectIndicator}
										/>
									)}

									{permissionModeLabel && (
										<span
											className={`hidden rounded border px-2 py-1 text-xs uppercase tracking-[0.08em] md:inline-flex ${
												sessionView?.permissionMode === "bypassPermissions"
													? "border-orange-400/25 bg-orange-400/8 text-orange-300"
													: "border-foreground/12 text-muted-foreground"
											}`}
										>
											{permissionModeLabel}
										</span>
									)}
									{sessionHeaderBadges.length > 0 && (
										<SessionStatsPopover badges={sessionHeaderBadges} />
									)}
									{sessionView && (
										<SessionActionsPopover
											session={sessionView}
											projects={projects}
											stream={sessionStream}
											copiedConversation={copiedConversation}
											hideThinking={hideThinking}
											fileBrowserOpen={fileBrowserOpen}
											onPin={(id, pinned) => handlePinned(id, pinned)}
											onRename={() =>
												setRenameState({ sessionId: sessionView.id, title: sessionView.title })
											}
											onCopy={handleCopyConversation}
											onMoveProject={(projectId) => void handleMoveSessionToProject(projectId)}
											onToggleFileBrowser={() => setFileBrowserOpen((v) => !v)}
											onToggleThinking={() =>
												setHiddenThinkingSessionIds((current) => {
													if (!selectedId) {
														return current;
													}

													const next = current.includes(selectedId)
														? current.filter((id) => id !== selectedId)
														: [...current, selectedId];

													window.localStorage.setItem(HIDDEN_THINKING_KEY, JSON.stringify(next));
													return next;
												})
											}
											onExportMarkdown={() => {
												const markdown = `# ${sessionView.title}\n\n${streamToMarkdown(sessionStream)}`;
												downloadFile(
													markdown,
													`${sanitizeFilename(sessionView.title)}.md`,
													"text/markdown",
												);
											}}
											onExportJson={() => {
												const data = {
													id: sessionView.id,
													title: sessionView.title,
													cwd: sessionView.cwd,
													provider: sessionView.provider,
													model: sessionView.model,
													createdAt: sessionView.createTime,
													usage: sessionView.usage,
													events: sessionStream.map((event) => ({
														id: event.id,
														kind: event.kind,
														sequence: event.sequence,
														data: event.data,
													})),
												};
												downloadFile(
													JSON.stringify(data, null, 2),
													`${sanitizeFilename(sessionView.title)}.json`,
													"application/json",
												);
											}}
											onArchive={(id, archived) => handleArchive(id, archived)}
											canEditSystemPrompt={sessionView.provider === "claude"}
											onEditSystemPrompt={() =>
												setSystemPromptEdit({
													sessionId: sessionView.id,
													systemPrompt: sessionView.systemPrompt ?? "",
												})
											}
										/>
									)}
									{sessionView &&
										(sessionView.status === "running" || sessionView.status === "retrying") && (
											<button
												type="button"
												onClick={() => void handleInterrupt()}
												className="flex items-center justify-center gap-1 rounded border border-foreground/12 px-2 py-1 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 text-xs text-muted-foreground transition hover:border-foreground/18 hover:text-foreground"
											>
												<CircleStop className="size-3 md:size-2.5" />
												<span className="hidden md:inline">Stop</span>
											</button>
										)}
								</div>
							</div>
						</header>

						<SessionTranscript
							firstSequence={sessionStream[0]?.sequence ?? null}
							grouped={grouped}
							hasEarlier={sessionTotalEvents > sessionStream.length}
							isRunning={sessionView?.status === "running" || sessionView?.status === "retrying"}
							isSessionPending={isSessionPending}
							loadEarlier={selectedId ? loadEarlierEvents : null}
							onPrependEarlier={prependEarlierEvents}
							onRespond={handleRespond}
							pendingRequests={sessionPendingRequests}
							session={sessionView}
							statusMessage={statusMessage}
						/>

						<div className="shrink-0 px-3 md:px-6 py-3 md:py-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:pb-4">
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
											{sessionQueuedInputs.length > 0 && (
												<div className="border-b border-border px-4 py-3">
													<div className="mb-2 text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
														Queued
													</div>
													<div className="space-y-2">
														{sessionQueuedInputs.map((queuedInput, index) => {
															const attachmentLabel = formatQueuedAttachmentLabel(queuedInput);
															const isEditing = editingQueuedInputId === queuedInput.id;
															const isBusy = busyQueuedInputId === queuedInput.id;

															return (
																<div
																	key={queuedInput.id}
																	className="rounded-md border border-foreground/10 bg-background/42 px-3 py-2"
																>
																	<div className="flex items-center justify-between gap-3">
																		<div className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
																			#{index + 1}
																		</div>
																		<div className="flex items-center gap-1">
																			{attachmentLabel && (
																				<div className="mr-1 text-xs text-muted-foreground">
																					{attachmentLabel}
																				</div>
																			)}
																			{isBusy ? (
																				<div className="flex size-6 items-center justify-center">
																					<Loader2 className="size-3 animate-spin text-muted-foreground" />
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
											{isVoiceRecording ? (
												<div className="flex flex-col gap-2 px-3 py-3">
													<VoiceWaveform analyser={activeVoiceSession.analyser} />
													<div className="flex items-center justify-between gap-2">
														<div className="flex items-center gap-1.5">
															<InputPlusMenu
																canAttach={canAttach}
																onAttach={() => fileInputRef.current?.click()}
															/>
															{sessionView && (sessionProvider?.models ?? []).length > 0 && (
																<InputModelPicker
																	session={sessionView}
																	models={sessionProvider?.models ?? []}
																	onChangeModel={(model) =>
																		void handleChangeModel(
																			sessionView,
																			model,
																			sessionProvider?.models ?? [],
																		)
																	}
																/>
															)}
															{sessionView && (
																<InputEffortPicker
																	models={sessionProvider?.models ?? []}
																	session={sessionView}
																	onChangeEffort={(effort) =>
																		void handleChangeEffort(
																			sessionView,
																			effort,
																			sessionProvider?.models ?? [],
																		)
																	}
																/>
															)}
														</div>
														<div className="flex items-center gap-1.5">
															<button
																type="button"
																onClick={handleVoiceCancel}
																className="flex size-7 items-center justify-center rounded border border-foreground/10 text-muted-foreground transition hover:text-foreground hover:border-foreground/20"
																title="Cancel recording"
															>
																<X className="size-3.5" />
															</button>
															<button
																type="button"
																onClick={() => void handleVoiceRecord()}
																className="flex size-7 items-center justify-center rounded bg-foreground text-background shadow-[0_0_18px_oklch(1_0_0_/_0.12)] transition hover:bg-foreground/85"
																title="Stop and transcribe"
															>
																<Check className="size-3.5" />
															</button>
														</div>
													</div>
												</div>
											) : (
												<div className="flex flex-col px-2 pb-2 pt-1">
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
														placeholder={getComposerPlaceholder(
															sessionProviderLabel,
															isSessionBusy,
															canAttach,
														)}
														className="min-h-[48px] md:min-h-[64px] w-full resize-none bg-transparent px-3.5 py-3 text-base leading-[1.6] text-foreground outline-none placeholder:text-muted-foreground md:text-xs"
													/>
													<div className="flex items-center justify-between px-1.5 pb-0.5">
														<div className="flex items-center gap-1.5">
															<InputPlusMenu
																canAttach={canAttach}
																onAttach={() => fileInputRef.current?.click()}
															/>
															{sessionView && (sessionProvider?.models ?? []).length > 0 && (
																<InputModelPicker
																	session={sessionView}
																	models={sessionProvider?.models ?? []}
																	onChangeModel={(model) =>
																		void handleChangeModel(
																			sessionView,
																			model,
																			sessionProvider?.models ?? [],
																		)
																	}
																/>
															)}
															{sessionView && (
																<InputEffortPicker
																	models={sessionProvider?.models ?? []}
																	session={sessionView}
																	onChangeEffort={(effort) =>
																		void handleChangeEffort(
																			sessionView,
																			effort,
																			sessionProvider?.models ?? [],
																		)
																	}
																/>
															)}
														</div>
														<div className="flex items-center gap-1.5">
															{isVoiceBusy ? (
																<>
																	<button
																		type="button"
																		onClick={handleVoiceCancel}
																		className="flex size-7 items-center justify-center rounded border border-foreground/10 text-muted-foreground transition hover:text-foreground hover:border-foreground/20"
																		title="Cancel voice input"
																	>
																		<X className="size-3.5" />
																	</button>
																	<button
																		type="button"
																		disabled
																		className="flex size-7 items-center justify-center rounded bg-foreground text-background shadow-[0_0_18px_oklch(1_0_0_/_0.12)] opacity-60"
																		title={
																			voiceState.status === "loading-model"
																				? `Loading model… ${Math.round(voiceState.progress)}%`
																				: "Transcribing…"
																		}
																	>
																		<Loader2 className="size-3.5 animate-spin" />
																	</button>
																</>
															) : prompt.trim().length > 0 || draftAttachments.length > 0 ? (
																<button
																	type="button"
																	onClick={() => void handleSend()}
																	disabled={!canSend}
																	title="Send message"
																	aria-label="Send message"
																	className="flex size-7 items-center justify-center rounded bg-foreground text-background shadow-[0_0_18px_oklch(1_0_0_/_0.12)] transition hover:bg-foreground/85 disabled:opacity-20"
																>
																	<Send className="size-3.5" />
																</button>
															) : (
																<button
																	type="button"
																	onClick={() => void handleVoiceRecord()}
																	className="flex size-7 items-center justify-center rounded border border-foreground/10 text-muted-foreground transition hover:text-foreground hover:border-foreground/20"
																	title="Voice input"
																>
																	<Mic className="size-3.5" />
																</button>
															)}
														</div>
													</div>
												</div>
											)}
											{queuedInputCount > 0 && (
												<div className="px-4 pb-1.5 text-xs text-muted-foreground">
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
							<span className="text-xs font-semibold uppercase tracking-[0.15em] text-foreground/82">
								🐚 shelleport
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
											<p className="mt-1 text-xs leading-[1.7] text-muted-foreground">
												Check managed provider readiness once, then pick a project directory below.
											</p>
										</div>
										<div className="flex flex-col gap-1 text-xs text-muted-foreground">
											{managedProviders.map((provider) => (
												<div key={provider.id} className="flex items-center gap-2">
													{provider.status === "ready" ? (
														<Check className="size-3 text-foreground/80" />
													) : (
														<X className="size-3 text-destructive/80" />
													)}
													<span>
														{provider.label}{" "}
														{provider.status === "ready" ? "ready" : "needs attention"}
													</span>
												</div>
											))}
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
									{managedProviders
										.filter((provider) => provider.statusDetail)
										.map((provider) => (
											<p
												key={provider.id}
												className="mt-3 text-xs leading-[1.7] text-muted-foreground"
											>
												{provider.label}: {provider.statusDetail}
											</p>
										))}
									<div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
										<span className="rounded border border-foreground/10 bg-background px-2 py-1 text-foreground/86">
											shelleport doctor
										</span>
									</div>
								</div>
							</div>
						)}
						<SessionLauncher
							key={boot.defaultCwd}
							createDisabledReason={createDisabledReason}
							createLabel={createProvider?.label ?? "managed"}
							createProviderId={createProvider?.id ?? null}
							createProviders={creatableProviders}
							defaultPath={boot.defaultCwd}
							isCreating={isCreating}
							models={createProvider?.models ?? []}
							onCreate={handleCreateSession}
							onCreateProviderChange={setCreateProviderId}
							projects={projects}
							onProjectCreated={(project) => setProjects((prev) => [...prev, project])}
						/>
					</>
				)}
			</main>
		</div>
	);
}
