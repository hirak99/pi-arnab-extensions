import type { Message } from "pi-durable-inbox";

import type { WatchDefinition, WatchRuntimeState } from "./types.ts";

/** Renders notification bodies and the watch_tail status trailer. */

export function formatInline(watch: WatchDefinition, body: string): string {
	return `Watch "${watch.name}" fired:\n\n${body}`;
}

export function formatReference(watch: WatchDefinition): string {
	return `Watch "${watch.name}" fired with output too large to inline. Use watch_tail with name "${watch.name}" to read it.`;
}

/** watch_tail trailer: one bracketed line describing live state. */
export function statusLine(state: WatchRuntimeState): string {
	if (state.status === "paused") return "[status]: watch is paused";
	if (state.status === "stopped") return "[status]: watch is stopped (session ended; resume or recreate to run again)";
	if (state.pid !== null) return "[status]: script is still running";
	if (state.exit_signal) return `[status]: script exited with signal ${state.exit_signal}`;
	if (state.exit_code !== null) return `[status]: script exited with code ${state.exit_code}`;
	if (state.next_run_at) {
		return `[status]: restarting (attempt ${state.restart_attempt}, next try at ${state.next_run_at})`;
	}
	return "[status]: idle";
}

export interface CoalescedBatch {
	total: number;
	lines: string[];
}

/**
 * Body for a rate-limited notification: the last few event lines plus an
 * explicit suppression trailer pointing at watch_tail.
 */
export function formatCoalesced(watch: WatchDefinition, batch: CoalescedBatch): string {
	const header = `Watch "${watch.name}": ${batch.total} events (rate-limited):`;
	const lines = batch.lines.map((line, index) => `[${index + 1}] ${line}`);
	const hidden = batch.total - batch.lines.length;
	const trailer = hidden > 0
		? `${hidden} notifications before this not shown; use watch_tail with name "${watch.name}" for the full list.`
		: `Use watch_tail with name "${watch.name}" for the full list.`;
	return [header, ...lines, trailer].join("\n");
}

export function truncateBody(body: string, maxChars: number): string {
	if (body.length <= maxChars) return body;
	return `${body.slice(0, maxChars)}\n… (truncated; use watch_tail for full output)`;
}

export function exitDescription(code: number | null, signal: string | null): string {
	if (signal) return `signal ${signal}`;
	if (code !== null) return `code ${code}`;
	return "unknown exit";
}

export function brokeBody(watch: WatchDefinition, code: number | null, signal: string | null, tail: string[]): string {
	const detail = tail.length > 0 ? `\n\nRecent output:\n${tail.join("\n")}` : "";
	return `Watch "${watch.name}": script broke (exited with ${exitDescription(code, signal)}).${detail}\nUse watch_tail with name "${watch.name}" for the full output.`;
}

export function finishedBody(watch: WatchDefinition, tail: string[]): string {
	const detail = tail.length > 0 ? `\n\nFinal output:\n${tail.join("\n")}` : "";
	return `Watch "${watch.name}": script finished.${detail}`;
}

/** Sender identity shown in inbox prompts. */
export function senderIdentity(watch: WatchDefinition): { name: string } {
	return { name: `watch "${watch.name}" (${watch.mode})` };
}

export function describeMessage(message: Message): string {
	return message.metadata.id;
}
