import { motion } from "motion/react";
import {
	ChevronLeft,
	ChevronRight,
	FileText,
	Folder,
	FolderOpen,
	Loader2,
	Plus,
	Search,
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
import { fetchDirectory } from "~/client/api";
import {
	getDefaultPermissionMode,
	type DirectoryEntry,
	type DirectoryListing,
	type PermissionMode,
	type ProviderId,
} from "~/shared/shelleport";

type SessionLauncherProps = {
	createDisabledReason: string | null;
	createLabel: string;
	createProviderId: ProviderId | null;
	defaultPath: string;
	isCreating: boolean;
	onCreate: (cwd: string, title: string, permissionMode: PermissionMode) => void | Promise<void>;
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
	const effectiveActiveEntryPath =
		activeEntryPath !== null && entries.some((entry) => entry.path === activeEntryPath)
			? activeEntryPath
			: preferredEntryPath;
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
			className={`flex h-full w-full md:w-64 shrink-0 flex-col overflow-hidden rounded-xl border ${
				isActiveColumn
					? "border-foreground/18 bg-card shadow-[0_18px_50px_oklch(0_0_0_/_0.28)]"
					: "border-foreground/10 bg-card/82 shadow-[inset_0_1px_0_oklch(1_0_0_/_0.02)]"
			} outline-none focus-visible:ring-1 focus-visible:ring-foreground/18 ${isFocusedColumn ? "ring-1 ring-foreground/18" : ""}`}
		>
			<header className="border-b border-foreground/8 px-3 py-2.5">
				<div className="flex items-center justify-between gap-2">
					<div className="min-w-0">
						<p className="truncate text-[11px] font-medium text-foreground/92">
							{getPathName(path)}
						</p>
						<p className="mt-0.5 truncate text-[10px] text-muted-foreground/68">{path}</p>
					</div>
					{isLoading && <Loader2 className="size-3 animate-spin text-muted-foreground/78" />}
				</div>
				<div className="relative mt-2">
					<label htmlFor={searchInputId} className="sr-only">
						Search {getPathName(path)}
					</label>
					<Search
						aria-hidden="true"
						className="pointer-events-none absolute top-1/2 left-2.5 size-3 -translate-y-1/2 text-muted-foreground/72"
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
						className="h-10 md:h-8 w-full rounded-md border border-foreground/10 bg-background/55 pr-2 pl-7 text-[11px] text-foreground outline-none transition placeholder:text-muted-foreground/68 focus-visible:border-foreground/20 focus-visible:ring-1 focus-visible:ring-foreground/12"
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
										className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-3 md:py-2 text-left text-[11px] transition ${
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
												className="size-3.5 shrink-0 text-muted-foreground/74"
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
										className={`flex items-center gap-2 rounded-lg px-2.5 py-3 md:py-2 text-[11px] ${
											isFocusedColumn && isActive
												? "bg-foreground/88 text-background ring-1 ring-background/20"
												: isHovered
													? "bg-foreground/8 text-foreground/72"
													: isActive
														? "bg-foreground/14 text-foreground/72"
														: "text-muted-foreground/72"
										}`}
									>
										<FileText aria-hidden="true" className="size-3.5 shrink-0" />
										<span className="min-w-0 truncate">{entry.name}</span>
									</div>
								);
							})}
						</div>
					) : (
						<div className="flex h-full items-center justify-center px-4 text-center text-[11px] text-muted-foreground/72">
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
	defaultPath,
	isCreating,
	onCreate,
}: SessionLauncherProps) {
	const titleInputId = useId();
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
	const [permissionMode, setPermissionMode] = useState<PermissionMode>(
		createProviderId ? getDefaultPermissionMode(createProviderId) : "default",
	);
	const showsPermissionMode = createProviderId === "claude";
	const [isMobile, setIsMobile] = useState(false);

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
		if (focusPath === null) {
			return;
		}

		const column = columnRefs.current[focusPath];
		if (!column) {
			return;
		}

		column.focus();
		setFocusPath(null);
	}, [focusPath, visiblePathChain]);

	useEffect(() => {
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
	}, [visiblePathChain]);

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

	return (
		<div className="flex h-full flex-col">
			<div className="border-b border-border px-3 md:px-6 py-4 md:py-5">
				<div className="mx-auto flex w-full max-w-[110rem] flex-col md:flex-row md:items-end md:justify-between gap-4 md:gap-6">
					<div className="min-w-0 flex-1">
						<p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-foreground/68">
							New Session
						</p>
						<h1 className="mt-2 text-lg font-medium tracking-[-0.04em] text-foreground">
							Pick a workspace. Launch from the path itself.
						</h1>
						<p className="mt-2 max-w-2xl text-[11px] leading-[1.8] text-muted-foreground/88">
							Finder-style column browsing. Directories expand to the right. Files stay visible for
							context.
						</p>
					</div>
					<div className="w-full max-w-sm shrink-0">
						<label
							htmlFor={titleInputId}
							className="mb-1.5 block text-[10px] font-medium uppercase tracking-[0.14em] text-foreground/68"
						>
							Title
						</label>
						<input
							id={titleInputId}
							name="title"
							type="text"
							value={title}
							onChange={(event) => setTitle(event.target.value)}
							autoComplete="off"
							placeholder="Optional session title…"
							className="h-10 w-full rounded-md border border-foreground/10 bg-card/90 px-3 text-xs text-foreground outline-none transition placeholder:text-muted-foreground/70 focus-visible:border-foreground/22 focus-visible:ring-1 focus-visible:ring-foreground/14"
						/>
					</div>
				</div>
				{showsPermissionMode && (
					<div className="mx-auto mt-4 flex w-full max-w-[110rem] flex-col md:flex-row md:items-start md:justify-between gap-4 md:gap-6 border-t border-foreground/12 pt-4">
						<div className="min-w-0">
							<p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-foreground/68">
								Claude permissions
							</p>
							<p className="mt-1 max-w-2xl text-[11px] leading-[1.7] text-muted-foreground/84">
								Bypass works best here. Claude approval prompts are unreliable in shelleport.
							</p>
						</div>
						<div className="grid w-full max-w-xl grid-cols-1 md:grid-cols-2 gap-2">
							<button
								type="button"
								onClick={() => setPermissionMode("bypassPermissions")}
								className={`rounded-md border px-3 py-2.5 text-left transition ${
									permissionMode === "bypassPermissions"
										? "border-foreground/20 bg-foreground text-background"
										: "border-foreground/10 bg-card/90 text-foreground/90 hover:border-foreground/18"
								}`}
							>
								<p className="text-[11px] font-medium">Bypass permissions</p>
								<p
									className={`mt-1 text-[10px] leading-[1.5] ${
										permissionMode === "bypassPermissions"
											? "text-background/78"
											: "text-muted-foreground/82"
									}`}
								>
									Recommended. Runs best in shelleport.
								</p>
							</button>
							<button
								type="button"
								onClick={() => setPermissionMode("default")}
								className={`rounded-md border px-3 py-2.5 text-left transition ${
									permissionMode === "default"
										? "border-foreground/20 bg-foreground text-background"
										: "border-foreground/10 bg-card/90 text-foreground/90 hover:border-foreground/18"
								}`}
							>
								<p className="text-[11px] font-medium">Ask for approvals</p>
								<p
									className={`mt-1 text-[10px] leading-[1.5] ${
										permissionMode === "default" ? "text-background/78" : "text-muted-foreground/82"
									}`}
								>
									Available, but prompts do not work especially well yet.
								</p>
							</button>
						</div>
					</div>
				)}
			</div>

			<div className="border-b border-border px-3 md:px-6 py-3">
				<div className="mx-auto flex w-full max-w-[110rem] flex-col md:flex-row md:items-center md:justify-between gap-3 md:gap-4">
					<div className="min-w-0 flex-1 rounded-md border border-foreground/10 bg-card/86 px-3 py-2 shadow-[inset_0_1px_0_oklch(1_0_0_/_0.03)]">
						<div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.14em] text-foreground/65">
							<FolderOpen aria-hidden="true" className="size-3" />
							Selected Directory
						</div>
						<p className="mt-1 truncate text-xs text-foreground/92">{currentPath}</p>
					</div>
					<button
						type="button"
						onClick={() => void onCreate(currentPath, title.trim(), permissionMode)}
						disabled={isCreating || createDisabledReason !== null}
						className="flex h-12 md:h-10 w-full md:w-auto shrink-0 items-center justify-center gap-2 rounded-md bg-foreground px-4 text-xs font-medium text-background transition hover:bg-foreground/90 focus-visible:ring-2 focus-visible:ring-foreground/20 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-30"
					>
						{isCreating ? (
							<Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
						) : (
							<Plus aria-hidden="true" className="size-3.5" />
						)}
						{`Create ${createLabel} session`}
					</button>
				</div>
				{createDisabledReason && (
					<div className="mx-auto mt-3 w-full max-w-[110rem] rounded-md border border-border bg-card/86 px-3 py-2 text-[11px] text-muted-foreground">
						{createDisabledReason}
					</div>
				)}
				{error && (
					<div className="mx-auto mt-3 w-full max-w-[110rem] rounded-md border border-destructive/25 bg-destructive/8 px-3 py-2 text-[11px] text-destructive">
						{error}
					</div>
				)}
			</div>

			<div className="min-h-0 flex-1 px-3 md:px-6 py-4 md:py-5">
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
							className="flex h-10 items-center gap-1.5 rounded-lg border border-foreground/10 bg-card/90 px-3 text-[11px] text-foreground/84 active:bg-accent"
						>
							<ChevronLeft className="size-3.5" />
							Back
						</button>
						<div className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground/80">
							{currentPath}
						</div>
					</div>
				)}
				<div
					ref={browserRef}
					className="mx-auto flex h-full w-full max-w-[110rem] gap-3 overflow-hidden pb-2"
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
		</div>
	);
}
