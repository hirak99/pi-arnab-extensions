import type { WatchRuntimeState } from "./types.ts";

/** Footer label for current-session watches; undefined hides the status item. */
export function formatWatcherStatus(
	watches: Array<{ state: Pick<WatchRuntimeState, "status" | "broken"> }>,
): string | undefined {
	const total = watches.length;
	if (total === 0) return undefined;
	const active = watches.filter(({ state }) => state.status === "running").length;
	const broken = watches.filter(({ state }) => state.broken).length;
	const noun = total === 1 ? "watcher" : "watchers";
	return `👀 ${active}/${total} ${noun} active${broken > 0 ? ` · ${broken} broken` : ""}`;
}
