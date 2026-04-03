import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	FileText,
	Folder,
	FolderOpen,
	Loader2,
	Plus,
	Search,
	Settings2,
} from "lucide-react";
import {
	type KeyboardEvent,
	startTransition,
	useEffect,
	useMemo,
	useDeferredValue,
	useId,
	useRef,
	useState,
} from "react";
import { createProject, fetchDirectory } from "~/client/api";
import { useToast } from "~/client/components/toast";
import {
	readLastSessionPreferences,
	writeLastSessionPreferences,
} from "~/client/session-preferences";
import {
	getDefaultEffortLevel,
	getDefaultPermissionMode,
	getSupportedEffortLevels,
	normalizeEffortLevel,
	type DirectoryEntry,
	type DirectoryListing,
	type EffortLevel,
	type PermissionMode,
	type ProviderModel,
	type ProviderId,
	type ProviderSummary,
	type Project,
} from "~/shared/shelleport";

const EFFORT_LEVELS: { id: EffortLevel; label: string }[] = [
	{ id: "low", label: "Low" },
	{ id: "medium", label: "Medium" },
	{ id: "high", label: "High" },
	{ id: "max", label: "Max" },
];

function getEffortLevels(modelId: string | null, models: ProviderModel[]) {
	const supportedLevels = getSupportedEffortLevels(modelId, models);
	return EFFORT_LEVELS.filter((level) => supportedLevels.includes(level.id));
}

const MODEL_SELECT_CLASS =
	"h-7 w-full cursor-pointer appearance-none rounded-md border border-foreground/10 bg-card/90 py-0 pl-2.5 pr-8 text-xs text-foreground outline-none transition focus-visible:border-foreground/22 focus-visible:ring-1 focus-visible:ring-foreground/14";

function ModelPickerSelect({
	id,
	models,
	selectedModel,
	onPick,
}: {
	id?: string;
	models: ProviderModel[];
	selectedModel: string | null;
	onPick: (modelId: string) => void;
}) {
	const value =
		models.length === 0
			? ""
			: (models.find((model) => model.id === selectedModel)?.id ?? models[0]!.id);

	if (models.length === 0) {
		return (
			<div className="flex h-7 items-center rounded-md border border-dashed border-foreground/12 bg-card/40 px-2.5 text-xs text-muted-foreground">
				CLI default model
			</div>
		);
	}

	return (
		<div className="relative">
			<select
				id={id}
				value={value}
				aria-label={id ? undefined : "Model"}
				onChange={(event) => onPick(event.target.value)}
				className={MODEL_SELECT_CLASS}
			>
				{models.map((model) => (
					<option key={model.id} value={model.id}>
						{model.label}
					</option>
				))}
			</select>
			<ChevronDown
				aria-hidden="true"
				className="pointer-events-none absolute top-1/2 right-2.5 size-3 -translate-y-1/2 text-muted-foreground"
			/>
		</div>
	);
}

type SessionLauncherProps = {
	createDisabledReason: string | null;
	createLabel: string;
	createProviderId: ProviderId | null;
	createProviders: ProviderSummary[];
	defaultPath: string;
	isCreating: boolean;
	models: ProviderModel[];
	onCreate: (input: {
		cwd: string;
		title: string;
		permissionMode: PermissionMode;
		model?: string;
		effort?: EffortLevel | null;
		systemPrompt?: string;
		projectId?: string;
	}) => void | Promise<void>;
	onCreateProviderChange: (providerId: ProviderId) => void;
	projects: Project[];
	onProjectCreated: (project: Project) => void;
};

const ROOT_PATH = "/";
const COLUMN_WIDTH_PX = 256;
const COLUMN_GAP_PX = 12;

function getPathChain(path: string) {
	if (path === ROOT_PATH) {
		return [ROOT_PATH];
	}

	const segments = path.split("/").filter(Boolean);
	const chain = [ROOT_PATH];
	let currentPath = "";

	for (const segment of segments) {
		currentPath += `/${segment}`;
		chain.push(currentPath);
	}

	return chain;
}

function getPathName(path: string) {
	return path === ROOT_PATH ? "top level" : (path.split("/").at(-1) ?? path);
}

type DirectoryColumnProps = {
	columnRef: (node: HTMLElement | null) => void;
	currentPath: string;
	isActiveColumn: boolean;
	isFocusedColumn: boolean;
	isLoading: boolean;
	nextPath: string | null;
	onCollapse: () => void;
	onColumnFocus: () => void;
	onSelect: (entry: DirectoryEntry) => void;
	path: string;
	listing: DirectoryListing | undefined;
};

function DirectoryColumn({
	columnRef,
	currentPath,
	isActiveColumn,
	isFocusedColumn,
	isLoading,
	listing,
	nextPath,
	onCollapse,
	onColumnFocus,
	onSelect,
	path,
}: DirectoryColumnProps) {
	const [query, setQuery] = useState("");
	const deferredQuery = useDeferredValue(query);
	const [activeEntryPath, setActiveEntryPath] = useState<string | null>(null);
	const [hoveredEntryPath, setHoveredEntryPath] = useState<string | null>(null);
	const listId = useId();
	const searchInputId = useId();
	const searchRef = useRef<HTMLInputElement>(null);
	const entryRefs = useRef<Record<string, HTMLButtonElement | HTMLDivElement | null>>({});
	const normalizedQuery = deferredQuery.trim().toLocaleLowerCase();
	const entries = useMemo(() => {
		if (!listing) {
			return [];
		}

		if (normalizedQuery.length === 0) {
			return listing.entries;
		}

		return listing.entries.filter((entry) =>
			entry.name.toLocaleLowerCase().includes(normalizedQuery),
		);
	}, [listing, normalizedQuery]);
	const preferredEntryPath = entries.find((entry) => entry.path === nextPath)?.path ?? null;
	/** When there is no path hint (new column / leaf), default to first row so Arrow keys + Enter work immediately. */
	const effectiveActiveEntryPath =
		activeEntryPath !== null && entries.some((entry) => entry.path === activeEntryPath)
			? activeEntryPath
			: (preferredEntryPath ?? entries[0]?.path ?? null);
	const activeEntryIndex =
		effectiveActiveEntryPath === null
			? -1
			: entries.findIndex((entry) => entry.path === effectiveActiveEntryPath);

	useEffect(() => {
		if (effectiveActiveEntryPath === null) {
			return;
		}

		entryRefs.current[effectiveActiveEntryPath]?.scrollIntoView({ block: "nearest" });
	}, [effectiveActiveEntryPath]);

	function setActiveEntryAt(index: number) {
		const nextEntry = entries[index];
		if (!nextEntry) {
			return;
		}

		setActiveEntryPath(nextEntry.path);
	}

	function selectEntry() {
		if (activeEntryIndex === -1) {
			return;
		}

		const activeEntry = entries[activeEntryIndex];
		if (!activeEntry || activeEntry.kind !== "directory") {
			return;
		}

		onSelect(activeEntry);
	}

	function handleKeyCommand(key: string, source: "column" | "search") {
		if (entries.length === 0) {
			if (key === "/" && source === "column") {
				searchRef.current?.focus();
				searchRef.current?.select();
				return true;
			}

			if (key === "ArrowLeft") {
				onCollapse();
				return true;
			}

			return false;
		}

		switch (key) {
			case "ArrowDown":
				setActiveEntryAt(Math.min(entries.length - 1, Math.max(0, activeEntryIndex + 1)));
				return true;
			case "ArrowUp":
				setActiveEntryAt(Math.max(0, activeEntryIndex <= 0 ? 0 : activeEntryIndex - 1));
				return true;
			case "Home":
				if (source === "search") {
					return false;
				}

				setActiveEntryAt(0);
				return true;
			case "End":
				if (source === "search") {
					return false;
				}

				setActiveEntryAt(entries.length - 1);
				return true;
			case "ArrowRight":
			case "Enter":
			case " ":
				selectEntry();
				return true;
			case "ArrowLeft":
				if (source === "search" && query.length > 0) {
					return false;
				}

				onCollapse();
				return true;
			case "/":
				if (source === "search") {
					return false;
				}

				searchRef.current?.focus();
				searchRef.current?.select();
				return true;
			case "Escape":
				if (source === "column") {
					if (query.length === 0) {
						return false;
					}

					setQuery("");
					return true;
				}

				if (query.length > 0) {
					setQuery("");
					return true;
				}

				searchRef.current?.blur();
				return true;
			default:
				return false;
		}
	}

	function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
		if (!handleKeyCommand(event.key, "column")) {
			return;
		}

		event.preventDefault();
	}

	return (
		<motion.section
			ref={columnRef}
			layout="position"
			initial={{ opacity: 0, x: 10 }}
			animate={{ opacity: 1, x: 0 }}
			transition={{ duration: 0.16, ease: "easeOut" }}
			data-active-column={isActiveColumn || undefined}
			tabIndex={0}
			onFocus={onColumnFocus}
			onKeyDown={handleKeyDown}
			className={`flex min-h-[18rem] w-full shrink-0 flex-col overflow-hidden rounded-xl border md:h-full md:min-h-0 md:w-64 ${
				isActiveColumn
					? "border-foreground/18 bg-card shadow-[0_18px_50px_oklch(0_0_0_/_0.28)]"
					: "border-foreground/10 bg-card/82 shadow-[inset_0_1px_0_oklch(1_0_0_/_0.02)]"
			} outline-none focus-visible:ring-1 focus-visible:ring-foreground/18 ${isFocusedColumn ? "ring-1 ring-foreground/18" : ""}`}
		>
			<header className="border-b border-foreground/8 px-3 py-2.5">
				<div className="flex items-center justify-between gap-2">
					<div className="min-w-0">
						<p className="truncate text-[0.8125rem] font-medium text-foreground/92">
							{getPathName(path)}
						</p>
						<p className="mt-0.5 truncate text-[0.6875rem] text-muted-foreground">{path}</p>
					</div>
					{isLoading && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
				</div>
				<div className="relative mt-2">
					<label htmlFor={searchInputId} className="sr-only">
						Search {getPathName(path)}
					</label>
					<Search
						aria-hidden="true"
						className="pointer-events-none absolute top-1/2 left-2.5 size-3 -translate-y-1/2 text-muted-foreground"
					/>
					<input
						id={searchInputId}
						ref={searchRef}
						type="text"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						onFocus={onColumnFocus}
						onKeyDown={(event) => {
							if (handleKeyCommand(event.key, "search")) {
								event.preventDefault();
							}
						}}
						placeholder="Search…"
						aria-controls={listId}
						autoComplete="off"
						className="h-10 md:h-8 w-full rounded-md border border-foreground/10 bg-background/55 pr-2 pl-7 text-xs text-foreground outline-none transition placeholder:text-muted-foreground focus-visible:border-foreground/20 focus-visible:ring-1 focus-visible:ring-foreground/12"
					/>
				</div>
			</header>

			<div
				id={listId}
				role="listbox"
				aria-label={getPathName(path)}
				className="min-h-0 flex-1 overflow-y-auto p-1.5"
			>
				{listing ? (
					entries.length > 0 ? (
						<div className="space-y-1">
							{entries.map((entry) => {
								const isInOpenPath = nextPath === entry.path;
								const isCurrentSelection = entry.path === currentPath;
								const isPathAncestor = isInOpenPath && !isCurrentSelection;
								const isActive = effectiveActiveEntryPath === entry.path;
								const isHovered = hoveredEntryPath === entry.path;
								const isDirectory = entry.kind === "directory";

								return isDirectory ? (
									<button
										key={entry.path}
										ref={(node) => {
											entryRefs.current[entry.path] = node;
										}}
										type="button"
										onClick={() => onSelect(entry)}
										onFocus={() => {
											onColumnFocus();
											setHoveredEntryPath(null);
											setActiveEntryPath(entry.path);
										}}
										onMouseEnter={() => setHoveredEntryPath(entry.path)}
										onMouseLeave={() =>
											setHoveredEntryPath((current) => (current === entry.path ? null : current))
										}
										role="option"
										aria-selected={isInOpenPath}
										style={{ contentVisibility: "auto", containIntrinsicSize: "36px" }}
										className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-3 md:py-2 text-left text-xs transition ${
											isCurrentSelection
												? "bg-foreground/88 text-background ring-1 ring-background/20 shadow-[0_10px_30px_oklch(1_0_0_/_0.08)]"
												: isPathAncestor
													? "bg-foreground/10 text-foreground ring-1 ring-foreground/16"
													: isFocusedColumn && isActive
														? "bg-foreground/14 text-foreground ring-1 ring-foreground/12"
														: isHovered
															? "bg-foreground/8 text-foreground"
															: "text-foreground/84 hover:bg-foreground/8 hover:text-foreground"
										} ${!isFocusedColumn && !isCurrentSelection && !isPathAncestor && isActive ? "bg-foreground/10 text-foreground" : ""}`}
									>
										{isInOpenPath ? (
											<FolderOpen aria-hidden="true" className="size-3.5 shrink-0" />
										) : (
											<Folder
												aria-hidden="true"
												className="size-3.5 shrink-0 text-muted-foreground"
											/>
										)}
										<span className="min-w-0 flex-1 truncate">{entry.name}</span>
										<ChevronRight aria-hidden="true" className="size-3 shrink-0 opacity-60" />
									</button>
								) : (
									<div
										key={entry.path}
										ref={(node) => {
											entryRefs.current[entry.path] = node;
										}}
										role="option"
										aria-selected={false}
										onMouseEnter={() => setHoveredEntryPath(entry.path)}
										onMouseLeave={() =>
											setHoveredEntryPath((current) => (current === entry.path ? null : current))
										}
										style={{ contentVisibility: "auto", containIntrinsicSize: "36px" }}
										className={`flex items-center gap-2 rounded-lg px-2.5 py-3 md:py-2 text-xs ${
											isFocusedColumn && isActive
												? "bg-foreground/88 text-background ring-1 ring-background/20"
												: isHovered
													? "bg-foreground/8 text-foreground/72"
													: isActive
														? "bg-foreground/14 text-foreground/72"
														: "text-muted-foreground"
										}`}
									>
										<FileText aria-hidden="true" className="size-3.5 shrink-0" />
										<span className="min-w-0 truncate">{entry.name}</span>
									</div>
								);
							})}
						</div>
					) : (
						<div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted-foreground">
							{normalizedQuery.length > 0 ? "No matches" : "Empty directory"}
						</div>
					)
				) : (
					<div className="space-y-2 p-1">
						{Array.from({ length: 9 }).map((_, skeletonIndex) => (
							<div key={skeletonIndex} className="h-8 animate-pulse rounded-lg bg-foreground/5" />
						))}
					</div>
				)}
			</div>
		</motion.section>
	);
}

export function SessionLauncher({
	createDisabledReason,
	createLabel,
	createProviderId,
	createProviders,
	defaultPath,
	isCreating,
	models,
	onCreate,
	onCreateProviderChange,
	projects,
	onProjectCreated,
}: SessionLauncherProps) {
	const { showToast } = useToast();
	const titleInputId = useId();
	const modelSelectId = useId();
	const [title, setTitle] = useState("");
	const [currentPath, setCurrentPath] = useState(defaultPath);
	const [activeColumnPath, setActiveColumnPath] = useState(defaultPath);
	const [directoryMap, setDirectoryMap] = useState<Record<string, DirectoryListing>>({});
	const [loadingPaths, setLoadingPaths] = useState<Record<string, true>>({});
	const [error, setError] = useState<string | null>(null);
	const [visibleColumnCount, setVisibleColumnCount] = useState(1);
	const [windowStartIndex, setWindowStartIndex] = useState(0);
	const browserRef = useRef<HTMLDivElement>(null);
	const columnRefs = useRef<Record<string, HTMLElement | null>>({});
	const [focusPath, setFocusPath] = useState<string | null>(null);
	const defaultModel = models.find((m) => m.id === "sonnet")?.id ?? models[0]?.id ?? null;
	const [initialPreferences] = useState(() => readLastSessionPreferences(models, defaultModel));
	const [selectedModel, setSelectedModel] = useState<string | null>(initialPreferences.model);
	const [selectedEffort, setSelectedEffort] = useState<EffortLevel>(initialPreferences.effort);
	const [permissionMode, setPermissionMode] = useState<PermissionMode>(
		createProviderId ? getDefaultPermissionMode(createProviderId) : "default",
	);
	const showsPermissionMode =
		createProviders.find((provider) => provider.id === createProviderId)?.capabilities
			.supportsApprovals ?? false;
	const [isMobile, setIsMobile] = useState(false);
	const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
	const [showNewProject, setShowNewProject] = useState(false);
	const [newProjectName, setNewProjectName] = useState("");
	const [isCreatingProject, setIsCreatingProject] = useState(false);
	const [saveAsProject, setSaveAsProject] = useState(false);
	const [saveAsProjectName, setSaveAsProjectName] = useState("");
	const [systemPrompt, setSystemPrompt] = useState("");
	const [showMobileOptions, setShowMobileOptions] = useState(false);
	const [showAdvancedOptions, setShowAdvancedOptions] = useState(false);
	const prefersReducedMotion = useReducedMotion();
	const effortLevels = getEffortLevels(selectedModel, models);
	const panelEase = [0.25, 1, 0.5, 1] as const;
	/** Tween rotate explicitly so chevron isn't treated as a spring; keep in sync with panels. */
	const chevronTransition =
		prefersReducedMotion === true
			? { duration: 0 }
			: { type: "tween" as const, duration: 0.16, ease: panelEase };
	const toggleLabelTransition =
		prefersReducedMotion === true
			? { duration: 0 }
			: { type: "tween" as const, duration: 0.16, ease: panelEase };

	/** Opacity + translateY only (GPU); avoid maxHeight/padding animation (layout thrash). */
	const collapsiblePanelTransition =
		prefersReducedMotion === true
			? { duration: 0 }
			: { type: "tween" as const, duration: 0.16, ease: panelEase };

	function pickModel(modelId: string) {
		setSelectedModel(modelId);
		setSelectedEffort(
			(current) =>
				normalizeEffortLevel(modelId, current, models) ??
				getDefaultEffortLevel(modelId, models) ??
				"medium",
		);
	}

	useEffect(() => {
		writeLastSessionPreferences(selectedModel, selectedEffort, models);
	}, [models, selectedEffort, selectedModel]);

	useEffect(() => {
		const fallbackModel =
			models.find((model) => model.id === "sonnet")?.id ?? models[0]?.id ?? null;
		const nextPreferences = readLastSessionPreferences(models, fallbackModel);
		setSelectedModel(nextPreferences.model);
		setSelectedEffort(nextPreferences.effort);

		if (selectedProjectId === null && !showNewProject) {
			setPermissionMode(createProviderId ? getDefaultPermissionMode(createProviderId) : "default");
		}
	}, [createProviderId, models, selectedProjectId, showNewProject]);

	useEffect(() => {
		const mql = window.matchMedia("(max-width: 767px)");
		setIsMobile(mql.matches);
		const handler = (event: MediaQueryListEvent) => setIsMobile(event.matches);
		mql.addEventListener("change", handler);
		return () => mql.removeEventListener("change", handler);
	}, []);

	const pathChain = useMemo(() => getPathChain(currentPath), [currentPath]);
	const visiblePathChain = useMemo(
		() => pathChain.slice(windowStartIndex, windowStartIndex + visibleColumnCount),
		[pathChain, visibleColumnCount, windowStartIndex],
	);

	useEffect(() => {
		if (isMobile) {
			setFocusPath(null);
			return;
		}

		if (focusPath === null) {
			return;
		}

		const column = columnRefs.current[focusPath];
		if (!column) {
			return;
		}

		column.focus();
		setFocusPath(null);
	}, [focusPath, isMobile, visiblePathChain]);

	useEffect(() => {
		if (isMobile) {
			setActiveColumnPath((current) => (current === currentPath ? current : currentPath));
			return;
		}

		const lastVisiblePath = visiblePathChain.at(-1);
		if (!lastVisiblePath) {
			return;
		}

		const activeColumn = document.activeElement;
		const columnNode = columnRefs.current[lastVisiblePath];

		if (!columnNode) {
			return;
		}

		if (activeColumn instanceof HTMLElement && columnNode.contains(activeColumn)) {
			return;
		}

		setActiveColumnPath(lastVisiblePath);
		setFocusPath(lastVisiblePath);
	}, [currentPath, isMobile, visiblePathChain]);

	useEffect(() => {
		setWindowStartIndex((current) => {
			const maxStartIndex = Math.max(0, pathChain.length - visibleColumnCount);

			if (current > maxStartIndex) {
				return maxStartIndex;
			}

			if (current + visibleColumnCount < pathChain.length) {
				return pathChain.length - visibleColumnCount;
			}

			return current;
		});
	}, [pathChain, visibleColumnCount]);

	useEffect(() => {
		let cancelled = false;
		const missingPaths = pathChain.filter(
			(path) => directoryMap[path] === undefined && loadingPaths[path] === undefined,
		);

		if (missingPaths.length === 0) {
			return;
		}

		setLoadingPaths((current) => {
			const next = { ...current };

			for (const path of missingPaths) {
				next[path] = true;
			}

			return next;
		});

		void Promise.all(missingPaths.map((path) => fetchDirectory(path)))
			.then((listings) => {
				if (cancelled) {
					return;
				}

				startTransition(() => {
					setDirectoryMap((current) => {
						const next = { ...current };

						for (const listing of listings) {
							next[listing.path] = listing;
						}

						return next;
					});
					setLoadingPaths((current) => {
						const next = { ...current };

						for (const path of missingPaths) {
							delete next[path];
						}

						return next;
					});
					setError(null);
				});
			})
			.catch((nextError: Error) => {
				if (cancelled) {
					return;
				}

				startTransition(() => {
					setLoadingPaths((current) => {
						const next = { ...current };

						for (const path of missingPaths) {
							delete next[path];
						}

						return next;
					});
					setError(nextError.message);
				});
			});

		return () => {
			cancelled = true;
		};
	}, [directoryMap, pathChain]);

	useEffect(() => {
		const browser = browserRef.current;

		if (!browser) {
			return;
		}

		const observer = new ResizeObserver((entries) => {
			const width = entries[0]?.contentRect.width ?? browser.clientWidth;
			const nextCount = Math.max(
				1,
				Math.floor((width + COLUMN_GAP_PX) / (COLUMN_WIDTH_PX + COLUMN_GAP_PX)),
			);

			setVisibleColumnCount((current) => (current === nextCount ? current : nextCount));
		});

		observer.observe(browser);

		return () => observer.disconnect();
	}, []);

	const handleCreate = async () => {
		let projectIdToUse = selectedProjectId;

		if (saveAsProject && !selectedProjectId) {
			try {
				const result = await createProject({
					name: saveAsProjectName.trim() || title.trim() || "Untitled Project",
					cwd: currentPath,
					permissionMode,
				});
				onProjectCreated(result.project);
				projectIdToUse = result.project.id;
			} catch {
				showToast("error", "Failed to create project");
				return;
			}
		}

		const resolvedModelId =
			models.length === 0
				? null
				: (models.find((model) => model.id === selectedModel)?.id ?? models[0]?.id ?? null);

		await onCreate({
			cwd: currentPath,
			title: title.trim(),
			permissionMode,
			model: resolvedModelId ?? undefined,
			effort:
				resolvedModelId === null
					? undefined
					: (normalizeEffortLevel(resolvedModelId, selectedEffort, models) ?? undefined),
			systemPrompt: systemPrompt.trim() || undefined,
			projectId: projectIdToUse ?? undefined,
		});
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col overflow-y-auto md:overflow-hidden">
			<div className="border-b border-border flex flex-wrap px-3 py-3 md:px-6 md:py-4">
				<div className="mx-auto flex min-w-0 w-full max-w-[110rem] flex-col gap-3">
					<div className="flex min-w-0 flex-1 flex-wrap items-start justify-between gap-x-4 gap-y-2">
						<div className="min-w-0">
							<p className="text-[0.6875rem] font-semibold uppercase tracking-[0.16em] text-foreground/68">
								New Session
							</p>
							<h1 className="mt-0.5 text-base font-medium tracking-[-0.02em] text-foreground">
								Pick a workspace for your session.
							</h1>
						</div>
						{/* Desktop create button */}
						<button
							type="button"
							onClick={handleCreate}
							disabled={isCreating || createDisabledReason !== null}
							className="hidden h-9 min-w-[14rem] shrink-0 items-center justify-center gap-1.5 rounded-md bg-foreground px-3 text-[0.8125rem] font-medium text-background transition hover:bg-foreground/90 focus-visible:ring-2 focus-visible:ring-foreground/20 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-30 md:flex"
						>
							{isCreating ? (
								<Loader2 aria-hidden="true" className="size-3 animate-spin" />
							) : (
								<Plus aria-hidden="true" className="size-3" />
							)}
							{`Create ${createLabel} session`}
						</button>
					</div>

					{/* Mobile: inline model selector + options toggle */}
					{isMobile && (
						<div className="mt-1.5 space-y-1.5">
							<div className="flex items-center gap-2">
								<div className="min-w-0 flex-1">
									<ModelPickerSelect
										models={models}
										selectedModel={selectedModel}
										onPick={pickModel}
									/>
								</div>
								<motion.button
									type="button"
									onClick={() => setShowMobileOptions((v) => !v)}
									className="flex h-7 shrink-0 items-center gap-1 rounded-md border border-foreground/10 bg-card/90 px-2 text-[0.6875rem] text-foreground/70 transition-colors active:bg-accent"
									whileHover={prefersReducedMotion === true ? undefined : { scale: 1.03 }}
									whileTap={prefersReducedMotion === true ? undefined : { scale: 0.97 }}
								>
									<Settings2 className="size-3" />
									<motion.span
										animate={{ rotate: showMobileOptions ? 180 : 0 }}
										transition={chevronTransition}
										className="inline-flex"
									>
										<ChevronDown className="size-3" />
									</motion.span>
								</motion.button>
							</div>

							{/* Collapsible options on mobile */}
							<AnimatePresence initial={false}>
								{showMobileOptions && (
									<motion.div
										key="session-launcher-mobile-more"
										className="w-full min-w-0 max-w-full space-y-3 overflow-hidden rounded-md border border-foreground/8 bg-card/40 p-3"
										style={{ isolation: "isolate" }}
										initial={prefersReducedMotion === true ? false : { opacity: 0, y: -6 }}
										animate={{ opacity: 1, y: 0 }}
										exit={
											prefersReducedMotion === true
												? { opacity: 0, transition: { duration: 0 } }
												: { opacity: 0, y: -4 }
										}
										transition={collapsiblePanelTransition}
									>
										{createProviders.length > 1 && (
											<div className="space-y-1">
												<p className="text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-foreground/68">
													Provider
												</p>
												<div className="flex flex-wrap gap-1.5">
													{createProviders.map((provider) => (
														<button
															key={provider.id}
															type="button"
															onClick={() => onCreateProviderChange(provider.id)}
															className={`rounded-md border px-2.5 py-1 text-xs font-medium transition ${
																createProviderId === provider.id
																	? "border-foreground/20 bg-foreground text-background"
																	: "border-foreground/10 bg-card/90 text-foreground/90 hover:border-foreground/18"
															}`}
														>
															{provider.label}
														</button>
													))}
												</div>
											</div>
										)}

										{/* Project */}
										<div className="space-y-1">
											<div>
												<p className="text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-foreground/68">
													Project
												</p>
												<p className="text-[0.6875rem] text-muted-foreground/60">
													Saved workspace and permission presets
												</p>
											</div>
											<div className="flex flex-wrap gap-1.5">
												<button
													type="button"
													onClick={() => {
														setSelectedProjectId(null);
														setShowNewProject(false);
													}}
													className={`rounded-md border px-2.5 py-1 text-xs font-medium transition ${
														selectedProjectId === null && !showNewProject
															? "border-foreground/20 bg-foreground text-background"
															: "border-foreground/10 bg-card/90 text-foreground/90 hover:border-foreground/18"
													}`}
												>
													None
												</button>
												{projects.map((project) => (
													<button
														key={project.id}
														type="button"
														onClick={() => {
															setSelectedProjectId(project.id);
															setShowNewProject(false);
															if (project.cwd) setCurrentPath(project.cwd);
															if (project.permissionMode) setPermissionMode(project.permissionMode);
														}}
														className={`rounded-md border px-2.5 py-1 text-xs font-medium transition ${
															selectedProjectId === project.id
																? "border-foreground/20 bg-foreground text-background"
																: "border-foreground/10 bg-card/90 text-foreground/90 hover:border-foreground/18"
														}`}
													>
														{project.name}
													</button>
												))}
												<button
													type="button"
													onClick={() => {
														setShowNewProject(true);
														setSelectedProjectId(null);
													}}
													className={`rounded-md border px-2.5 py-1 text-xs font-medium transition ${
														showNewProject
															? "border-foreground/20 bg-foreground text-background"
															: "border-foreground/10 bg-card/90 text-foreground/90 hover:border-foreground/18"
													}`}
												>
													+ New
												</button>
											</div>
										</div>

										{/* Title */}
										<div className="space-y-1">
											<p className="text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-foreground/68">
												Title
											</p>
											<input
												type="text"
												value={title}
												onChange={(event) => setTitle(event.target.value)}
												autoComplete="off"
												placeholder="Optional session title…"
												className="h-7 w-full rounded-md border border-foreground/10 bg-card/90 px-2.5 text-xs text-foreground outline-none transition placeholder:text-muted-foreground focus-visible:border-foreground/22 focus-visible:ring-1 focus-visible:ring-foreground/14"
											/>
										</div>

										{/* Effort */}
										<div className="space-y-1">
											<div>
												<p className="text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-foreground/68">
													Effort
												</p>
												<p className="text-[0.6875rem] text-muted-foreground/60">
													How thoroughly the model reasons
												</p>
											</div>
											{effortLevels.length > 0 ? (
												<div className="flex min-h-7 flex-wrap content-start gap-1.5">
													{effortLevels.map((level) => (
														<button
															key={level.id}
															type="button"
															onClick={() => setSelectedEffort(level.id)}
															className={`rounded-md border px-2.5 py-1 text-xs font-medium transition ${
																selectedEffort === level.id
																	? "border-foreground/20 bg-foreground text-background"
																	: "border-foreground/10 bg-card/90 text-foreground/90 hover:border-foreground/18"
															}`}
														>
															{level.label}
														</button>
													))}
												</div>
											) : (
												<p className="min-h-7 text-[0.6875rem] leading-7 text-muted-foreground">
													Not configurable for this provider
												</p>
											)}
										</div>

										{/* Permissions */}
										{showsPermissionMode && (
											<div className="space-y-1">
												<div>
													<p className="text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-foreground/68">
														Permissions
													</p>
													<p className="text-[0.6875rem] text-muted-foreground/60">
														Whether the agent asks before acting
													</p>
												</div>
												<div className="flex gap-1.5">
													<button
														type="button"
														onClick={() => setPermissionMode("bypassPermissions")}
														className={`rounded-md border px-2.5 py-1 text-xs font-medium transition ${
															permissionMode === "bypassPermissions"
																? "border-foreground/20 bg-foreground text-background"
																: "border-foreground/10 bg-card/90 text-foreground/90 hover:border-foreground/18"
														}`}
													>
														Auto-approve
													</button>
													<button
														type="button"
														onClick={() => setPermissionMode("default")}
														className={`rounded-md border px-2.5 py-1 text-xs font-medium transition ${
															permissionMode === "default"
																? "border-foreground/20 bg-foreground text-background"
																: "border-foreground/10 bg-card/90 text-foreground/90 hover:border-foreground/18"
														}`}
													>
														Ask for approvals
													</button>
												</div>
											</div>
										)}

										{/* System prompt */}
										<div className="space-y-1">
											<p className="text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-foreground/68">
												System prompt
											</p>
											<textarea
												value={systemPrompt}
												onChange={(event) => setSystemPrompt(event.target.value)}
												placeholder="Custom instructions for this session…"
												rows={2}
												maxLength={10000}
												className="w-full resize-y rounded-md border border-foreground/10 bg-card/90 px-2.5 py-2 text-xs leading-[1.6] text-foreground outline-none transition placeholder:text-muted-foreground focus-visible:border-foreground/22 focus-visible:ring-1 focus-visible:ring-foreground/14"
											/>
										</div>
									</motion.div>
								)}
							</AnimatePresence>
						</div>
					)}

					{/* Desktop: essentials first; effort / permissions / prompt behind toggle */}
					<div
						className={`grid-cols-1 md:grid-cols-[1fr_1fr] gap-x-4 gap-y-3 md:items-start ${isMobile ? "hidden" : "grid"}`}
					>
						{createProviders.length > 1 && (
							<div className="space-y-1">
								<p className="text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-foreground/68">
									Provider
								</p>
								<div className="flex flex-wrap gap-1.5">
									{createProviders.map((provider) => (
										<button
											key={provider.id}
											type="button"
											onClick={() => onCreateProviderChange(provider.id)}
											className={`rounded-md border px-2.5 py-1 text-xs font-medium transition ${
												createProviderId === provider.id
													? "border-foreground/20 bg-foreground text-background"
													: "border-foreground/10 bg-card/90 text-foreground/90 hover:border-foreground/18"
											}`}
										>
											{provider.label}
										</button>
									))}
								</div>
							</div>
						)}

						{/* Row 1: Project */}
						<div className="space-y-1">
							<div>
								<p className="text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-foreground/68">
									Project
								</p>
								<p className="text-[0.6875rem] text-muted-foreground/60">
									Saved workspace and permission presets
								</p>
							</div>
							<div className="flex flex-wrap gap-1.5">
								<button
									type="button"
									onClick={() => {
										setSelectedProjectId(null);
										setShowNewProject(false);
										setCurrentPath(defaultPath);
										setPermissionMode(
											createProviderId ? getDefaultPermissionMode(createProviderId) : "default",
										);
									}}
									className={`rounded-md border px-2.5 py-1 text-xs font-medium transition ${
										selectedProjectId === null && !showNewProject
											? "border-foreground/20 bg-foreground text-background"
											: "border-foreground/10 bg-card/90 text-foreground/90 hover:border-foreground/18"
									}`}
								>
									None
								</button>
								{projects.map((project) => (
									<button
										key={project.id}
										type="button"
										onClick={() => {
											setSelectedProjectId(project.id);
											setShowNewProject(false);
											setCurrentPath(project.cwd);
											setPermissionMode(project.permissionMode);
										}}
										className={`max-w-32 truncate rounded-md border px-2.5 py-1 text-xs font-medium transition ${
											selectedProjectId === project.id
												? "border-foreground/20 bg-foreground text-background"
												: "border-foreground/10 bg-card/90 text-foreground/90 hover:border-foreground/18"
										}`}
									>
										{project.name}
									</button>
								))}
								<button
									type="button"
									onClick={() => {
										setShowNewProject(!showNewProject);
										setSelectedProjectId(null);
									}}
									className={`rounded-md border px-2.5 py-1 text-xs font-medium transition ${
										showNewProject
											? "border-foreground/20 bg-foreground text-background"
											: "border-foreground/10 bg-card/90 text-foreground/90 hover:border-foreground/18"
									}`}
								>
									+ New
								</button>
							</div>
							{showNewProject && (
								<div className="flex gap-1.5">
									<input
										type="text"
										value={newProjectName}
										onChange={(event) => setNewProjectName(event.target.value)}
										placeholder="Project name…"
										className="h-7 flex-1 rounded-md border border-foreground/10 bg-card/90 px-2.5 text-xs text-foreground outline-none transition placeholder:text-muted-foreground focus-visible:border-foreground/22 focus-visible:ring-1 focus-visible:ring-foreground/14"
									/>
									<button
										type="button"
										onClick={async () => {
											if (!newProjectName.trim()) {
												showToast("error", "Project name cannot be empty");
												return;
											}
											setIsCreatingProject(true);
											try {
												const result = await createProject({
													name: newProjectName.trim(),
													cwd: currentPath,
													permissionMode,
												});
												onProjectCreated(result.project);
												setSelectedProjectId(result.project.id);
												setNewProjectName("");
												setShowNewProject(false);
											} catch {
												showToast("error", "Failed to create project");
											} finally {
												setIsCreatingProject(false);
											}
										}}
										disabled={!newProjectName.trim() || isCreatingProject}
										className="flex h-7 items-center gap-1 rounded-md bg-foreground px-2.5 text-xs font-medium text-background transition hover:bg-foreground/90 disabled:opacity-30"
									>
										{isCreatingProject ? (
											<Loader2 className="size-3 animate-spin" />
										) : (
											<Plus className="size-3" />
										)}
										Create
									</button>
								</div>
							)}
						</div>

						{/* Row 1 right: Title */}
						<div className="space-y-1">
							<p className="text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-foreground/68">
								Title
							</p>
							<input
								id={titleInputId}
								name="title"
								type="text"
								value={title}
								onChange={(event) => setTitle(event.target.value)}
								autoComplete="off"
								placeholder="Optional session title…"
								className="h-7 w-full rounded-md border border-foreground/10 bg-card/90 px-2.5 text-xs text-foreground outline-none transition placeholder:text-muted-foreground focus-visible:border-foreground/22 focus-visible:ring-1 focus-visible:ring-foreground/14"
							/>
						</div>

						{/* Row 2: Model — single-line select aligns with Title (no chip grid dead zone) */}
						<div className="space-y-1">
							<label
								htmlFor={modelSelectId}
								className="block text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-foreground/68"
							>
								Model
							</label>
							<ModelPickerSelect
								id={modelSelectId}
								models={models}
								selectedModel={selectedModel}
								onPick={pickModel}
							/>
						</div>
					</div>

					{!isMobile && (
						<div className="hidden w-full min-w-0 md:flex md:flex-wrap md:items-center md:gap-2">
							<motion.button
								type="button"
								onClick={() => setShowAdvancedOptions((v) => !v)}
								aria-expanded={showAdvancedOptions}
								className="flex h-7 min-w-0 items-center gap-1 rounded-md border border-foreground/10 bg-card/70 px-2 text-[0.6875rem] text-foreground/80 transition-colors hover:bg-card hover:text-foreground"
								whileHover={prefersReducedMotion === true ? undefined : { scale: 1.02 }}
								whileTap={prefersReducedMotion === true ? undefined : { scale: 0.98 }}
							>
								<Settings2 className="size-3 shrink-0" aria-hidden="true" />
								{/* wait: avoids exit+enter labels in-flow at once (very wide bar) */}
								<AnimatePresence initial={false} mode="wait">
									<motion.span
										key={showAdvancedOptions ? "fewer" : "more"}
										initial={prefersReducedMotion === true ? false : { opacity: 0, y: 4 }}
										animate={{ opacity: 1, y: 0 }}
										exit={prefersReducedMotion === true ? { opacity: 0 } : { opacity: 0, y: -4 }}
										transition={toggleLabelTransition}
										className="inline-block max-w-full whitespace-nowrap"
									>
										{showAdvancedOptions ? "Fewer options" : "Effort, permissions, prompt"}
									</motion.span>
								</AnimatePresence>
								<motion.span
									animate={{ rotate: showAdvancedOptions ? 180 : 0 }}
									transition={chevronTransition}
									className="inline-flex shrink-0"
									aria-hidden="true"
								>
									<ChevronDown className="size-3" />
								</motion.span>
							</motion.button>
						</div>
					)}

					{!isMobile && (
						<AnimatePresence initial={false}>
							{showAdvancedOptions && (
								<motion.div
									key="session-launcher-advanced"
									className="grid min-w-0 w-full max-w-full grid-cols-2 gap-x-4 gap-y-3 overflow-hidden rounded-lg border border-foreground/8 bg-card/30 p-3"
									style={{ isolation: "isolate" }}
									initial={prefersReducedMotion === true ? false : { opacity: 0, y: -6 }}
									animate={{ opacity: 1, y: 0 }}
									exit={
										prefersReducedMotion === true
											? { opacity: 0, transition: { duration: 0 } }
											: { opacity: 0, y: -4 }
									}
									transition={collapsiblePanelTransition}
								>
									{/* Effort */}
									<div className="space-y-1">
										<div>
											<p className="text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-foreground/68">
												Effort
											</p>
											<p className="text-[0.6875rem] text-muted-foreground/60">
												How thoroughly the model reasons
											</p>
										</div>
										{effortLevels.length > 0 ? (
											<div className="flex min-h-7 flex-wrap content-start gap-1.5">
												{effortLevels.map((level) => (
													<button
														key={level.id}
														type="button"
														onClick={() => setSelectedEffort(level.id)}
														className={`rounded-md border px-2.5 py-1 text-xs font-medium transition ${
															selectedEffort === level.id
																? "border-foreground/20 bg-foreground text-background"
																: "border-foreground/10 bg-card/90 text-foreground/90 hover:border-foreground/18"
														}`}
													>
														{level.label}
													</button>
												))}
											</div>
										) : (
											<p className="min-h-7 text-[0.6875rem] leading-7 text-muted-foreground">
												Not configurable for this provider
											</p>
										)}
									</div>

									{/* Permissions */}
									{showsPermissionMode && (
										<div className="space-y-1">
											<div>
												<p className="text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-foreground/68">
													Permissions
												</p>
												<p className="text-[0.6875rem] text-muted-foreground/60">
													Whether the agent asks before acting
												</p>
											</div>
											<div className="flex flex-wrap gap-1.5">
												<button
													type="button"
													onClick={() => setPermissionMode("bypassPermissions")}
													className={`rounded-md border px-2.5 py-1 text-xs font-medium transition ${
														permissionMode === "bypassPermissions"
															? "border-foreground/20 bg-foreground text-background"
															: "border-foreground/10 bg-card/90 text-foreground/90 hover:border-foreground/18"
													}`}
													title="Agent acts without asking for approval"
												>
													Auto-approve
												</button>
												<button
													type="button"
													onClick={() => setPermissionMode("default")}
													className={`rounded-md border px-2.5 py-1 text-xs font-medium transition ${
														permissionMode === "default"
															? "border-foreground/20 bg-foreground text-background"
															: "border-foreground/10 bg-card/90 text-foreground/90 hover:border-foreground/18"
													}`}
													title="Agent pauses for your approval before each action"
												>
													Ask for approvals
												</button>
											</div>
										</div>
									)}

									{/* System prompt — full width below effort / permissions */}
									<div className="space-y-1 md:col-span-2">
										<p className="text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-foreground/68">
											System prompt
										</p>
										<textarea
											value={systemPrompt}
											onChange={(event) => setSystemPrompt(event.target.value)}
											placeholder="Custom instructions for this session…"
											rows={2}
											maxLength={10000}
											className="w-full resize-y rounded-md border border-foreground/10 bg-card/90 px-2.5 py-1.5 text-xs leading-[1.5] text-foreground outline-none transition placeholder:text-muted-foreground focus-visible:border-foreground/22 focus-visible:ring-1 focus-visible:ring-foreground/14"
										/>
									</div>
								</motion.div>
							)}
						</AnimatePresence>
					)}

					{/* Selected directory bar */}
					<div className="flex flex-wrap items-center gap-2 rounded-md border border-foreground/8 bg-card/60 px-2.5 py-1.5">
						<FolderOpen aria-hidden="true" className="size-3 shrink-0 text-foreground/55" />
						<p className="min-w-0 flex-1 truncate text-[0.6875rem] text-foreground/80">{currentPath}</p>
						{selectedProjectId === null && !showNewProject && (
							<div className="flex shrink-0 items-center gap-1.5">
								<input
									type="checkbox"
									id="saveAsProject"
									checked={saveAsProject}
									onChange={(event) => setSaveAsProject(event.target.checked)}
									className="rounded border border-foreground/20 accent-foreground"
								/>
								<label htmlFor="saveAsProject" className="text-[0.6875rem] text-muted-foreground">
									Save as project
								</label>
								{saveAsProject && (
									<input
										type="text"
										value={saveAsProjectName}
										onChange={(event) => setSaveAsProjectName(event.target.value)}
										placeholder="Name…"
										className="h-7 w-28 rounded border border-foreground/10 bg-card/90 px-2 text-xs text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-foreground/22"
									/>
								)}
							</div>
						)}
					</div>
					{createDisabledReason && (
						<div className="rounded-md border border-border bg-card/86 px-2.5 py-1.5 text-[0.6875rem] text-muted-foreground">
							{createDisabledReason}
						</div>
					)}
					{error && (
						<div className="rounded-md border border-destructive/25 bg-destructive/8 px-2.5 py-1.5 text-[0.6875rem] text-destructive">
							{error}
						</div>
					)}
				</div>
			</div>

			<div className={`px-3 py-3 md:min-h-0 md:flex-1 md:px-6 md:py-4 ${isMobile ? "pb-20" : ""}`}>
				{isMobile && pathChain.length > 1 && (
					<div className="mx-auto flex max-w-[110rem] items-center gap-2 mb-3">
						<button
							type="button"
							onClick={() => {
								const parentPath = pathChain[pathChain.length - 2];
								if (parentPath) {
									setCurrentPath(parentPath);
									setActiveColumnPath(parentPath);
								}
							}}
							className="flex h-10 items-center gap-1.5 rounded-lg border border-foreground/10 bg-card/90 px-3 text-xs text-foreground/84 active:bg-accent"
						>
							<ChevronLeft className="size-3.5" />
							Back
						</button>
						<div className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
							{currentPath}
						</div>
					</div>
				)}
				<div
					ref={browserRef}
					className="mx-auto flex w-full max-w-[110rem] gap-3 overflow-hidden pb-2 md:h-full"
				>
					{(isMobile ? pathChain.slice(-1) : visiblePathChain).map((path, index) => {
						const absoluteIndex = windowStartIndex + index;
						const listing = directoryMap[path];
						const nextPath = pathChain[absoluteIndex + 1] ?? null;
						const isLoading = loadingPaths[path] === true;
						const isActiveColumn = index === visiblePathChain.length - 1;

						return (
							<DirectoryColumn
								key={path}
								columnRef={(node) => {
									columnRefs.current[path] = node;
								}}
								currentPath={currentPath}
								isActiveColumn={isActiveColumn}
								isFocusedColumn={path === activeColumnPath}
								isLoading={isLoading}
								listing={listing}
								nextPath={nextPath}
								onCollapse={() => {
									const parentPath = pathChain[absoluteIndex - 1];
									if (!parentPath) {
										return;
									}

									setCurrentPath(parentPath);
									setActiveColumnPath(parentPath);
									setFocusPath(parentPath);
									setError(null);
								}}
								onColumnFocus={() => {
									setActiveColumnPath(path);
								}}
								onSelect={(entry) => {
									const nextPathChain = getPathChain(entry.path);
									const isLastVisibleColumn =
										absoluteIndex === windowStartIndex + visibleColumnCount - 1;

									setCurrentPath(entry.path);
									setActiveColumnPath(entry.path);
									setFocusPath(entry.path);
									setWindowStartIndex((current) => {
										if (
											!isLastVisibleColumn ||
											nextPathChain.length <= current + visibleColumnCount
										) {
											return current;
										}

										return current + 1;
									});
									setError(null);
								}}
								path={path}
							/>
						);
					})}
				</div>
			</div>

			{/* Mobile sticky bottom create bar */}
			{isMobile && (
				<div
					className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-background/95 px-3 backdrop-blur-sm"
					style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
				>
					<div className="flex items-center gap-3 pt-3">
						<div className="min-w-0 flex-1">
							<div className="flex items-center gap-1.5">
								<FolderOpen aria-hidden="true" className="size-3 shrink-0 text-foreground/55" />
								<p className="min-w-0 truncate text-[0.6875rem] text-foreground/70">{currentPath}</p>
							</div>
						</div>
						<button
							type="button"
							onClick={handleCreate}
							disabled={isCreating || createDisabledReason !== null}
							className="flex h-10 shrink-0 items-center gap-1.5 rounded-lg bg-foreground px-4 text-[0.8125rem] font-medium text-background transition active:bg-foreground/90 disabled:opacity-30"
						>
							{isCreating ? (
								<Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
							) : (
								<Plus aria-hidden="true" className="size-3.5" />
							)}
							Launch
						</button>
					</div>
				</div>
			)}
		</div>
	);
}
