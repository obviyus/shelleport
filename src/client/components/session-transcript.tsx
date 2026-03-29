import { ArrowDown, Loader2 } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import type {
	HostEvent,
	HostSession,
	PendingRequest,
	RequestResponsePayload,
} from "~/shared/shelleport";
import {
	type GroupedEntry,
	GroupedEntryRenderer,
	PendingRequestBanner,
} from "~/client/session-stream";

type EarlierEventPage = {
	events: HostEvent[];
	totalEvents: number;
};

function getGroupedEntryKey(group: GroupedEntry) {
	return group.type === "tool"
		? group.call.id
		: group.type === "assistant-text-run"
			? (group.entries[0]?.id ?? "assistant-text-run")
			: group.entry.id;
}

export const SessionTranscript = memo(function SessionTranscript({
	firstSequence,
	grouped,
	hasEarlier,
	isRunning,
	isSessionPending,
	loadEarlier,
	onPrependEarlier,
	onRespond,
	pendingRequest,
	session,
	statusMessage,
}: {
	firstSequence: number | null;
	grouped: GroupedEntry[];
	hasEarlier: boolean;
	isRunning: boolean;
	isSessionPending: boolean;
	loadEarlier: ((before: number) => Promise<EarlierEventPage>) | null;
	onPrependEarlier: (page: EarlierEventPage) => void;
	onRespond: (id: string, payload: RequestResponsePayload) => void;
	pendingRequest: PendingRequest | null;
	session: HostSession | null;
	statusMessage: string | null;
}) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const isAtBottom = useRef(true);
	const [showScrollPill, setShowScrollPill] = useState(false);
	const [loadingEarlier, setLoadingEarlier] = useState(false);
	const previousTailKey = useRef(
		grouped.length > 0 ? getGroupedEntryKey(grouped[grouped.length - 1]!) : null,
	);

	useEffect(() => {
		const tailKey = grouped.length > 0 ? getGroupedEntryKey(grouped[grouped.length - 1]!) : null;

		if (isAtBottom.current && scrollRef.current) {
			scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
			setShowScrollPill(false);
		} else if (tailKey !== null && tailKey !== previousTailKey.current) {
			setShowScrollPill(true);
		}

		previousTailKey.current = tailKey;
	}, [grouped]);

	const handleScroll = useCallback(() => {
		const element = scrollRef.current;

		if (!element) {
			return;
		}

		isAtBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 60;

		if (isAtBottom.current) {
			setShowScrollPill(false);
		}
	}, []);

	function scrollToBottom() {
		if (scrollRef.current) {
			scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
			setShowScrollPill(false);
		}
	}

	const handleLoadEarlier = useCallback(async () => {
		if (!loadEarlier || loadingEarlier || firstSequence === null) {
			return;
		}

		setLoadingEarlier(true);

		try {
			const scrollElement = scrollRef.current;
			const previousScrollHeight = scrollElement?.scrollHeight ?? 0;
			const page = await loadEarlier(firstSequence);
			onPrependEarlier(page);

			requestAnimationFrame(() => {
				if (scrollElement) {
					scrollElement.scrollTop = scrollElement.scrollHeight - previousScrollHeight;
				}
			});
		} catch (error) {
			console.error("Failed to load earlier events:", error);
		} finally {
			setLoadingEarlier(false);
		}
	}, [firstSequence, loadEarlier, loadingEarlier, onPrependEarlier]);

	return (
		<>
			<div className="relative flex-1 overflow-hidden">
				<div
					ref={scrollRef}
					onScroll={handleScroll}
					className="h-full overflow-y-auto px-3 md:px-6 py-4 md:py-6"
				>
					{isSessionPending ? (
						<div className="flex h-full items-center justify-center">
							<Loader2 className="size-4 animate-spin text-muted-foreground/80" />
						</div>
					) : session && grouped.length === 0 && !isRunning ? (
						<div className="flex h-full items-center justify-center">
							<p className="text-xs text-muted-foreground/80">Send a message to start</p>
						</div>
					) : session ? (
						<div className="mx-auto max-w-[70rem]">
							{hasEarlier && (
								<div className="mb-4 flex justify-center">
									<button
										type="button"
										onClick={() => void handleLoadEarlier()}
										disabled={loadingEarlier}
										className="flex items-center gap-1.5 rounded-md border border-foreground/10 bg-card/90 px-3 py-1.5 text-[11px] text-muted-foreground/88 transition hover:border-foreground/18 hover:text-foreground disabled:opacity-40"
									>
										{loadingEarlier ? <Loader2 className="size-3 animate-spin" /> : null}
										Load earlier messages
									</button>
								</div>
							)}
							{statusMessage && (
								<div className="mb-5 rounded-lg border border-foreground/10 bg-card/90 px-4 py-3 text-[11px] text-muted-foreground/88">
									{statusMessage}
								</div>
							)}
							{grouped.map((group) => (
								<GroupedEntryRenderer key={getGroupedEntryKey(group)} group={group} />
							))}
							{isRunning && (
								<div className="animate-thinking mt-1 flex gap-1 py-2">
									<span className="size-1 rounded-full bg-foreground" />
									<span className="size-1 rounded-full bg-foreground" />
									<span className="size-1 rounded-full bg-foreground" />
								</div>
							)}
						</div>
					) : null}
				</div>

				{showScrollPill && (
					<div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center pb-3">
						<button
							type="button"
							onClick={scrollToBottom}
							className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-foreground/15 bg-card/95 px-3 py-1.5 text-[10px] font-medium text-foreground/80 shadow-lg backdrop-blur-sm transition hover:bg-card hover:text-foreground"
						>
							<ArrowDown className="size-3" />
							New messages
						</button>
					</div>
				)}
			</div>

			{session && pendingRequest && (
				<PendingRequestBanner request={pendingRequest} onRespond={onRespond} />
			)}
		</>
	);
});
