export type WatchMode = "poll" | "stream";

export type WatchStatus = "running" | "paused" | "stopped";

/**
 * A watch definition is everything needed to recreate the watch: durable on
 * disk, survives Pi restarts (the definition, not the running process).
 */
export interface WatchDefinition {
	id: string;
	name: string;
	mode: WatchMode;
	/** Shell command (run via `bash -c`). */
	run: string;
	/** Poll mode only: seconds between runs. Minimum 15. */
	every_seconds?: number | undefined;
	/** Stream mode only: regex; matching stdout lines become notifications. */
	match?: string | undefined;
	/** Stream mode only: notify when the script exits cleanly. */
	on_finish?: boolean | undefined;
	/** Optional lifetime cap on source alert events; reaching it removes the watch. */
	max_events?: number | undefined;
	/** Poll mode only: seconds before a single run is killed. */
	timeout_seconds: number;
	/** Poll mode only: seconds before the very first run; default 0 (fire immediately). */
	initial_delay_seconds?: number | undefined;
	/** Pi session that receives notifications. */
	session_id: string;
	created_at: string;
}

/** Volatile runtime state, persisted for watch_list/watch_tail status lines. */
export interface WatchRuntimeState {
	status: WatchStatus;
	pid: number | null;
	exit_code: number | null;
	exit_signal: string | null;
	broken: boolean;
	restart_attempt: number;
	/** ISO timestamp of the next scheduled action (poll tick or stream restart). */
	next_run_at: string | null;
	/** Total source alert events observed, including events coalesced into one notification. */
	event_count: number;
	/** ISO timestamp of the last delivered event, or null if never fired. */
	last_fired_at: string | null;
}

export function initialRuntimeState(status: WatchStatus = "stopped"): WatchRuntimeState {
	return {
		status,
		pid: null,
		exit_code: null,
		exit_signal: null,
		broken: false,
		restart_attempt: 0,
		next_run_at: null,
		event_count: 0,
		last_fired_at: null,
	};
}

export const MIN_EVERY_SECONDS = 15;
export const DEFAULT_EVERY_SECONDS = 60;
export const DEFAULT_TIMEOUT_SECONDS = 120;
/** Minimum seconds between delivered notifications for one watch. */
export const EVENT_RATE_FLOOR_SECONDS = 15;
/** Maximum characters of command output included in one notification. */
export const MAX_EVENT_BODY_CHARS = 2_000;
/** How many event lines a rate-limited notification includes. */
export const COALESCED_EVENT_LINES = 3;
