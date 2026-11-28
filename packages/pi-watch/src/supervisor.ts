import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createInterface, type Interface } from "node:readline";

import type { WatchRegistry } from "./registry.ts";
import {
	brokeBody,
	eventFooter,
	finishedBody,
	formatCoalesced,
	truncateBody,
} from "./format.ts";
import {
	COALESCED_EVENT_LINES,
	DEFAULT_EVERY_SECONDS,
	EVENT_RATE_FLOOR_SECONDS,
	MAX_EVENT_BODY_CHARS,
	MIN_EVERY_SECONDS,
	initialRuntimeState,
	type WatchDefinition,
	type WatchMode,
	type WatchRuntimeState,
} from "./types.ts";

export type Deliver = (watch: WatchDefinition, body: string) => Promise<void>;

interface WatchEntry {
	definition: WatchDefinition;
	state: WatchRuntimeState;
	child: ChildProcess | null;
	timer: NodeJS.Timeout | null;
	flushTimer: NodeJS.Timeout | null;
	lineReaders: Interface[];
	outputDrains: Promise<void>[];
	pendingOutput: Set<Promise<void>>;
	intentionalStop: boolean;
	timedOut: boolean;
	stdoutBuf: string;
	stderrBuf: string;
	outputTruncated: boolean;
	lastDeliverAt: number;
	pendingCount: number;
	pendingLines: string[];
	streamAttempt: number;
}

export class WatchError extends Error {}

const STREAM_BACKOFF_BASE_MS = 15_000;
const STREAM_BACKOFF_MAX_MS = 300_000;

interface SupervisorOptions {
	eventRateFloorMs?: number;
	/** Grace window that lets a burst of events coalesce into one delivery. */
	graceMs?: number;
	streamBackoffBaseMs?: number;
	streamBackoffMaxMs?: number;
	/** Test hook: lower bound for every_seconds validation. */
	minEverySeconds?: number;
	/** Called after watch visibility, active state, or broken state changes. */
	onStateChange?: () => void;
}

/**
 * Owns watch processes and notification semantics. Live supervisors bridge
 * in-process reloads; full shutdown persists running intent for exact-session
 * auto-resume.
 */
export class WatchSupervisor {
	private readonly registry: WatchRegistry;
	private deliver: Deliver;
	private readonly eventRateFloorMs: number;
	private readonly graceMs: number;
	private readonly streamBackoffBaseMs: number;
	private readonly streamBackoffMaxMs: number;
	private readonly minEverySeconds: number;
	private onStateChange: (() => void) | undefined;
	private shuttingDown = false;
	private readonly entries = new Map<string, WatchEntry>();

	constructor(registry: WatchRegistry, deliver: Deliver, options: SupervisorOptions = {}) {
		this.registry = registry;
		this.deliver = deliver;
		this.eventRateFloorMs = options.eventRateFloorMs ?? EVENT_RATE_FLOOR_SECONDS * 1000;
		this.graceMs = options.graceMs ?? 500;
		this.streamBackoffBaseMs = options.streamBackoffBaseMs ?? STREAM_BACKOFF_BASE_MS;
		this.streamBackoffMaxMs = options.streamBackoffMaxMs ?? STREAM_BACKOFF_MAX_MS;
		this.minEverySeconds = options.minEverySeconds ?? MIN_EVERY_SECONDS;
		this.onStateChange = options.onStateChange;
	}

	/** Rebind extension-owned callbacks when /reload adopts this live supervisor. */
	rebind(deliver: Deliver, onStateChange: (() => void) | undefined): void {
		this.deliver = deliver;
		this.onStateChange = onStateChange;
	}

	/**
	 * Cold-start only the exact owning session. A persisted running status is
	 * durable intent: full Pi shutdown preserves it, and exact-session resume
	 * starts it again. Other sessions' definitions and state files are untouched.
	 */
	async restore(sessionId: string): Promise<WatchDefinition[]> {
		this.shuttingDown = false;
		const definitions = (await this.registry.listDefinitions()).filter((definition) => definition.session_id === sessionId);
		const resume: WatchEntry[] = [];
		for (const definition of definitions) {
			const loaded = await this.registry.loadState(definition.id);
			const state = loaded ? { ...initialRuntimeState("stopped"), ...loaded } : initialRuntimeState("stopped");
			state.pid = null;
			const entry = this.newEntry(definition, state);
			this.entries.set(definition.id, entry);
			await this.registry.saveState(definition.id, state);
			if (state.status === "running") resume.push(entry);
		}
		this.onStateChange?.();
		for (const entry of resume) {
			const nextRunMs = entry.state.next_run_at ? Date.parse(entry.state.next_run_at) : Number.NaN;
			const remainingMs = Number.isFinite(nextRunMs) ? nextRunMs - Date.now() : 0;
			if (remainingMs > 0) {
				entry.timer = setTimeout(() => {
					entry.state.next_run_at = null;
					void this.startEntry(entry);
				}, remainingMs);
			} else {
				entry.state.next_run_at = null;
				void this.startEntry(entry);
			}
		}
		return definitions;
	}

	async create(input: {
		name: string;
		mode: WatchMode;
		run: string;
		everySeconds?: number | undefined;
		initialDelaySeconds?: number | undefined;
		match?: string | undefined;
		onFinish?: boolean | undefined;
		maxEvents?: number | undefined;
		timeoutSeconds?: number | undefined;
		sessionId: string;
	}): Promise<WatchDefinition> {
		const name = input.name.trim();
		if (!name) throw new WatchError("name must not be empty");
		if (name.includes("/")) throw new WatchError("name must not contain '/'");
		for (const entry of this.entries.values()) {
			if (entry.definition.session_id === input.sessionId && entry.definition.name === name) {
				throw new WatchError(`a watch named "${name}" already exists in this session`);
			}
		}
		if (input.mode === "poll") {
			const every = input.everySeconds ?? DEFAULT_EVERY_SECONDS;
			if (!Number.isInteger(every) || every < this.minEverySeconds) {
				throw new WatchError(`every_seconds must be an integer of at least ${this.minEverySeconds}`);
			}
		}
		let match: string | undefined;
		if (input.mode === "stream" && input.match !== undefined) {
			try {
				new RegExp(input.match);
			} catch {
				throw new WatchError(`match is not a valid regular expression: ${input.match}`);
			}
			match = input.match;
		}
		const timeoutSeconds = input.timeoutSeconds ?? 120;
		if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1) {
			throw new WatchError("timeout_seconds must be an integer of at least 1");
		}
		if (input.maxEvents !== undefined && (!Number.isInteger(input.maxEvents) || input.maxEvents < 1)) {
			throw new WatchError("max_events must be an integer of at least 1");
		}
		const initialDelaySeconds = input.initialDelaySeconds ?? 0;
		if (!Number.isInteger(initialDelaySeconds) || initialDelaySeconds < 0) {
			throw new WatchError("initial_delay_seconds must be an integer of at least 0");
		}
		const id = randomUUID();
		const definition: WatchDefinition = {
			id,
			name,
			mode: input.mode,
			run: input.run,
			...(input.mode === "poll" ? { every_seconds: input.everySeconds ?? DEFAULT_EVERY_SECONDS } : {}),
			...(input.mode === "poll" && initialDelaySeconds > 0 ? { initial_delay_seconds: initialDelaySeconds } : {}),
			...(match !== undefined ? { match } : {}),
			...(input.mode === "stream" && input.onFinish ? { on_finish: true } : {}),
			...(input.maxEvents !== undefined ? { max_events: input.maxEvents } : {}),
			timeout_seconds: timeoutSeconds,
			session_id: input.sessionId,
			created_at: new Date().toISOString(),
		};
		await this.registry.saveDefinition(definition);
		await mkdir(this.registry.scriptStatePath(definition.id), { recursive: true, mode: 0o700 });
		const entry = this.newEntry(definition, initialRuntimeState("running"));
		this.entries.set(definition.id, entry);
		this.onStateChange?.();
		await this.registry.appendLog(definition.id, `[status]: created (${definition.mode} mode)`);
		const initialDelayMs = definition.initial_delay_seconds ? definition.initial_delay_seconds * 1000 : 0;
		if (initialDelayMs > 0) {
			entry.state.next_run_at = new Date(Date.now() + initialDelayMs).toISOString();
			await this.registry.saveState(definition.id, entry.state);
			entry.timer = setTimeout(() => {
				entry.state.next_run_at = null;
				void this.pollTick(entry);
			}, initialDelayMs);
		} else {
			void this.startEntry(entry);
		}
		return definition;
	}

	list(sessionId: string): Array<{ definition: WatchDefinition; state: WatchRuntimeState }> {
		return [...this.entries.values()]
			.filter((entry) => entry.definition.session_id === sessionId)
			.map((entry) => ({
				definition: entry.definition,
				state: entry.state,
			}));
	}

	get(name: string, sessionId: string): { definition: WatchDefinition; state: WatchRuntimeState } {
		const entry = this.byName(name, sessionId);
		return { definition: entry.definition, state: entry.state };
	}

	getById(id: string): { definition: WatchDefinition; state: WatchRuntimeState } | undefined {
		const entry = this.entries.get(id);
		return entry ? { definition: entry.definition, state: entry.state } : undefined;
	}

	async pause(name: string, sessionId: string): Promise<void> {
		const entry = this.byName(name, sessionId);
		await this.stopEntry(entry, "paused");
	}

	async resume(name: string, sessionId: string): Promise<void> {
		const entry = this.byName(name, sessionId);
		if (entry.definition.max_events !== undefined && entry.state.event_count >= entry.definition.max_events) {
			throw new WatchError(`watch "${name}" has reached max_events=${entry.definition.max_events}; create a new watch to re-arm it`);
		}
		if (entry.state.status === "running") return;
		entry.state.status = "running";
		entry.state.broken = false;
		await this.registry.saveState(entry.definition.id, entry.state);
		this.onStateChange?.();
		await this.registry.appendLog(entry.definition.id, "[status]: resumed");
		void this.startEntry(entry);
	}

	async remove(name: string, sessionId: string): Promise<void> {
		const entry = this.byName(name, sessionId);
		await this.stopEntry(entry, "stopped");
		this.entries.delete(entry.definition.id);
		this.onStateChange?.();
		await this.registry.remove(entry.definition.id);
	}

	async tailDetails(name: string, sessionId: string, maxLines: number) {
		const entry = this.byName(name, sessionId);
		return this.registry.readLog(entry.definition.id, maxLines);
	}

	async tail(name: string, sessionId: string, maxLines: number): Promise<string[]> {
		const entry = this.byName(name, sessionId);
		return this.registry.readLogTail(entry.definition.id, maxLines);
	}

	/**
	 * Full process shutdown: stop scripts without erasing running intent. Reload
	 * does not call this path; it hands the live supervisor to the new runtime.
	 */
	async shutdown(): Promise<void> {
		this.shuttingDown = true;
		for (const entry of this.entries.values()) {
			await this.stopEntry(entry, entry.state.status, true);
		}
		await this.registry.closeLogs();
	}

	private byName(name: string, sessionId: string): WatchEntry {
		for (const entry of this.entries.values()) {
			if (entry.definition.session_id === sessionId && entry.definition.name === name) return entry;
		}
		throw new WatchError(`no watch named "${name}" in this session`);
	}

	private newEntry(definition: WatchDefinition, state: WatchRuntimeState): WatchEntry {
		return {
			definition,
			state,
			child: null,
			timer: null,
			flushTimer: null,
			lineReaders: [],
			outputDrains: [],
			pendingOutput: new Set(),
			intentionalStop: false,
			timedOut: false,
			stdoutBuf: "",
			stderrBuf: "",
			outputTruncated: false,
			lastDeliverAt: 0,
			pendingCount: 0,
			pendingLines: [],
			streamAttempt: state.restart_attempt,
		};
	}

	private async startEntry(entry: WatchEntry): Promise<void> {
		if (this.shuttingDown) return;
		if (entry.definition.mode === "poll") await this.pollTick(entry);
		else await this.streamStart(entry);
	}

	// ---------------------------------------------------------------- poll --

	private async pollTick(entry: WatchEntry): Promise<void> {
		if (this.shuttingDown || entry.state.status !== "running") return;
		const definition = entry.definition;
		const child = this.spawn(entry);
		entry.stdoutBuf = "";
		entry.stderrBuf = "";
		entry.outputTruncated = false;
		entry.timedOut = false;
		const timeoutMs = definition.timeout_seconds * 1000;
		const timeout = setTimeout(() => {
			entry.timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);
		this.attachLineReaders(entry, child, (line, stream) => {
			this.appendPollLine(entry, line, stream);
		});
		child.on("close", (code, signal) => {
			clearTimeout(timeout);
			void this.pollFinished(entry, child, code, signal).catch((error: Error) => this.logStatus(entry, `error: ${error.message}`));
		});
	}

	private async pollFinished(entry: WatchEntry, child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): Promise<void> {
		if (entry.child !== child) return;
		await Promise.all(entry.outputDrains);
		await Promise.all([...entry.pendingOutput]);
		if (entry.child !== child) return;
		entry.child = null;
		entry.lineReaders.forEach((reader) => reader.close());
		entry.lineReaders = [];
		await this.recordExit(entry, code, signal);
		const definition = entry.definition;
		if (!entry.intentionalStop && entry.state.status === "running") {
			if (entry.timedOut) {
				await this.broke(entry, null, "SIGKILL", "watchdog timeout");
			} else if (code === 0) {
				await this.recovered(entry);
			} else if (code === 1) {
				const output = `${entry.stdoutBuf}${entry.stderrBuf}`.trim();
				const boundedOutput = entry.outputTruncated && output ? `${output}\n…` : output;
				await this.event(entry, boundedOutput || `fired at ${new Date().toISOString()}`);
			} else {
				await this.broke(entry, code, signal, undefined);
			}
		}
		entry.intentionalStop = false;
		if (entry.state.status === "running") this.schedulePoll(entry);
		await this.registry.closeLog(entry.definition.id);
	}

	private appendPollLine(entry: WatchEntry, line: string, stream: "stdout" | "stderr"): void {
		const key = stream === "stdout" ? "stdoutBuf" : "stderrBuf";
		const text = `${line}\n`;
		const remaining = MAX_EVENT_BODY_CHARS - entry[key].length;
		if (remaining <= 0) {
			entry.outputTruncated = true;
			return;
		}
		entry[key] += text.slice(0, remaining);
		if (text.length > remaining) entry.outputTruncated = true;
	}

	private schedulePoll(entry: WatchEntry): void {
		const everyMs = (entry.definition.every_seconds ?? DEFAULT_EVERY_SECONDS) * 1000;
		entry.state.next_run_at = new Date(Date.now() + everyMs).toISOString();
		void this.persistState(entry);
		if (!this.shuttingDown) {
			entry.timer = setTimeout(() => {
				entry.state.next_run_at = null;
				void this.pollTick(entry);
			}, everyMs);
		}
	}

	// -------------------------------------------------------------- stream --

	private async streamStart(entry: WatchEntry): Promise<void> {
		if (this.shuttingDown || entry.state.status !== "running") return;
		const definition = entry.definition;
		const wasBroken = entry.state.broken;
		const child = this.spawn(entry);
		const matcher = definition.match !== undefined ? new RegExp(definition.match) : null;
		this.attachLineReaders(entry, child, (line, stream) => {
			if (stream === "stderr") return;
			if (line.trim() === "") return;
			if (!matcher || matcher.test(line)) void this.event(entry, line);
		});
		child.on("close", (code, signal) => {
			void this.streamFinished(entry, child, code, signal).catch((error: Error) => this.logStatus(entry, `error: ${error.message}`));
		});
		if (wasBroken) {
			entry.streamAttempt = 0;
			entry.state.restart_attempt = 0;
			entry.state.broken = false;
			await this.persistState(entry);
			this.onStateChange?.();
			await this.deliverSafely(entry, `Watch "${definition.name}": recovered (script restarted successfully).`);
		}
	}

	private async streamFinished(entry: WatchEntry, child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): Promise<void> {
		if (entry.child !== child) return;
		await Promise.all(entry.outputDrains);
		await Promise.all([...entry.pendingOutput]);
		if (entry.child !== child) return;
		entry.child = null;
		entry.lineReaders.forEach((reader) => reader.close());
		entry.lineReaders = [];
		await this.recordExit(entry, code, signal);
		const definition = entry.definition;
		if (entry.intentionalStop || entry.state.status !== "running") {
			entry.intentionalStop = false;
			await this.registry.closeLog(entry.definition.id);
			return;
		}
		if (code === 0) {
			entry.streamAttempt = 0;
			entry.state.restart_attempt = 0;
			entry.state.broken = false;
			entry.state.status = "stopped";
			await this.persistState(entry);
			this.onStateChange?.();
			if (definition.on_finish) {
				await this.deliverSafely(entry, finishedBody(definition, await this.registry.readLogTail(definition.id, 10)));
			}
			await this.registry.closeLog(definition.id);
			return;
		}
		await this.broke(entry, code, signal, entry.timedOut ? "watchdog timeout" : undefined);
		entry.streamAttempt += 1;
		entry.state.restart_attempt = entry.streamAttempt;
		const backoffMs = Math.min(this.streamBackoffBaseMs * 2 ** (entry.streamAttempt - 1), this.streamBackoffMaxMs);
		entry.state.next_run_at = new Date(Date.now() + backoffMs).toISOString();
		await this.persistState(entry);
		if (!this.shuttingDown) {
			entry.timer = setTimeout(() => {
				entry.state.next_run_at = null;
				void this.streamStart(entry);
			}, backoffMs);
		}
		await this.registry.closeLog(definition.id);
	}

	// -------------------------------------------------------------- shared --

	private spawn(entry: WatchEntry): ChildProcess {
		const definition = entry.definition;
		const child = spawn("/bin/bash", ["-c", definition.run], {
			env: {
				...process.env,
				WATCH_ID: definition.id,
				WATCH_NAME: definition.name,
				WATCH_MODE: definition.mode,
				WATCH_STATE: this.registry.scriptStatePath(definition.id),
			},
		});
		entry.child = child;
		entry.state.pid = child.pid ?? null;
		entry.state.exit_code = null;
		entry.state.exit_signal = null;
		void this.persistState(entry);
		return child;
	}

	private attachLineReaders(
		entry: WatchEntry,
		child: ChildProcess,
		onLine: (line: string, stream: "stdout" | "stderr") => void,
	): void {
		entry.outputDrains = [];
		for (const [stream, readable] of [["stdout", child.stdout], ["stderr", child.stderr]] as const) {
			if (!readable) continue;
			const reader = createInterface({ input: readable });
			entry.outputDrains.push(new Promise<void>((resolve) => reader.once("close", resolve)));
			reader.on("line", (line) => {
				reader.pause();
				const pending = this.registry.appendLog(entry.definition.id, `[${stream}]: ${line}`)
					.catch(() => undefined)
					.then(() => { onLine(line, stream); })
					.finally(() => {
						entry.pendingOutput.delete(pending);
						reader.resume();
					});
				entry.pendingOutput.add(pending);
			});
			entry.lineReaders.push(reader);
		}
	}

	private async persistState(entry: WatchEntry): Promise<void> {
		try {
			await this.registry.saveState(entry.definition.id, entry.state);
		} catch (error) {
			await this.registry.appendLog(
				entry.definition.id,
				`[status]: state save error: ${(error as Error).message}`,
			).catch(() => undefined);
		}
	}

	private async recordExit(entry: WatchEntry, code: number | null, signal: NodeJS.Signals | null): Promise<void> {
		entry.state.pid = null;
		entry.state.exit_code = code;
		entry.state.exit_signal = signal;
		if (code !== null || signal) {
			await this.registry
				.appendLog(entry.definition.id, `[status]: script exited with ${signal ? `signal ${signal}` : `code ${code}`}`)
				.catch(() => undefined);
		}
		await this.persistState(entry);
	}

	private async stopEntry(entry: WatchEntry, status: WatchRuntimeState["status"], preserveNextRun = false): Promise<void> {
		entry.intentionalStop = true;
		const nextRunAt = preserveNextRun ? entry.state.next_run_at : null;
		if (entry.timer) clearTimeout(entry.timer);
		if (entry.flushTimer) clearTimeout(entry.flushTimer);
		entry.timer = null;
		entry.flushTimer = null;
		const child = entry.child;
		entry.child = null;
		if (child && child.exitCode === null && !child.killed) child.kill("SIGTERM");
		entry.lineReaders.forEach((reader) => reader.close());
		entry.lineReaders = [];
		entry.state.status = status;
		entry.state.pid = null;
		entry.state.next_run_at = nextRunAt;
		await Promise.all(entry.outputDrains);
		await Promise.all([...entry.pendingOutput]);
		await this.flushPending(entry);
		await this.registry.saveState(entry.definition.id, entry.state);
		this.onStateChange?.();
		await this.registry.appendLog(
			entry.definition.id,
			status === "running"
				? "[status]: stopped for session shutdown; exact-session auto-resume armed"
				: `[status]: watch ${status}`,
		).catch(() => undefined);
		await this.registry.closeLog(entry.definition.id);
	}

	private async broke(entry: WatchEntry, code: number | null, signal: NodeJS.Signals | null, reason: string | undefined): Promise<void> {
		const first = !entry.state.broken;
		entry.state.broken = true;
		await this.persistState(entry);
		this.onStateChange?.();
		if (!first) return;
		const tail = await this.registry.readLogTail(entry.definition.id, 10);
		const body = reason
			? `Watch "${entry.definition.name}": script broke (${reason}).\nUse watch_tail with name "${entry.definition.name}" for recent retained output.`
			: brokeBody(entry.definition, code, signal, tail);
		await this.deliverSafely(entry, body);
	}

	private async recovered(entry: WatchEntry): Promise<void> {
		if (!entry.state.broken) return;
		entry.state.broken = false;
		entry.streamAttempt = 0;
		entry.state.restart_attempt = 0;
		await this.persistState(entry);
		this.onStateChange?.();
		await this.deliverSafely(entry, `Watch "${entry.definition.name}": recovered (check succeeded again).`);
	}

	/**
	 * Queue an event for delivery. Events are held for a short grace window so
	 * a burst coalesces into one notification (last few lines plus a
	 * suppression trailer); deliveries are additionally separated by the rate
	 * floor. Everything is appended to the watch log regardless.
	 */
	private async event(entry: WatchEntry, payload: string): Promise<void> {
		const maxEvents = entry.definition.max_events;
		if (maxEvents !== undefined && entry.state.event_count + entry.pendingCount >= maxEvents) return;
		entry.pendingCount += 1;
		entry.pendingLines.push(payload);
		if (entry.pendingLines.length > COALESCED_EVENT_LINES) entry.pendingLines.shift();
		const limitReached = maxEvents !== undefined && entry.state.event_count + entry.pendingCount >= maxEvents;
		if (limitReached) {
			// Mark this as an intentional stop before awaiting delivery so a
			// concurrently exiting stream cannot emit an extra on_finish notice.
			entry.intentionalStop = true;
			await this.flushPending(entry, true);
			await this.remove(entry.definition.name, entry.definition.session_id);
			return;
		}
		if (entry.flushTimer) return;
		const sinceLast = Date.now() - entry.lastDeliverAt;
		const wait = entry.lastDeliverAt === 0 || sinceLast >= this.eventRateFloorMs
			? this.graceMs
			: this.eventRateFloorMs - sinceLast;
		entry.flushTimer = setTimeout(() => {
			entry.flushTimer = null;
			void this.flushPending(entry);
		}, wait);
	}

	private async flushPending(entry: WatchEntry, cappedFinal = false): Promise<void> {
		if (entry.flushTimer) clearTimeout(entry.flushTimer);
		entry.flushTimer = null;
		if (entry.pendingCount === 0) return;
		const count = entry.pendingCount;
		const lines = [...entry.pendingLines];
		entry.pendingCount = 0;
		entry.pendingLines = [];
		const now = Date.now();
		entry.lastDeliverAt = now;
		const definition = entry.definition;
		// Sequence stats: this batch's position and the gap since the previous
		// event, appended as a compact footer to every fired notification.
		const previousCount = entry.state.event_count ?? 0;
		const sinceMs = entry.state.last_fired_at ? now - Date.parse(entry.state.last_fired_at) : null;
		entry.state.event_count = previousCount + count;
		entry.state.last_fired_at = new Date(now).toISOString();
		void this.persistState(entry);
		const body = count === 1
			? truncateBody(lines[0] ?? "", MAX_EVENT_BODY_CHARS, !cappedFinal)
			: formatCoalesced(definition, { total: count, lines }, !cappedFinal);
		const wrapped = body.startsWith(`Watch `) ? body : `Watch "${definition.name}" fired:\n\n${body}`;
		const capNotice = cappedFinal ? `\n\nmax_events=${definition.max_events} reached; watch stopped and removed.` : "";
		await this.deliverSafely(entry, `${wrapped}${capNotice}\n\n${eventFooter(previousCount + 1, previousCount + count, sinceMs)}`);
	}

	private async deliverSafely(entry: WatchEntry, body: string): Promise<void> {
		try {
			await this.deliver(entry.definition, body);
		} catch (error) {
			await this.registry
				.appendLog(entry.definition.id, `[status]: delivery error: ${(error as Error).message}`)
				.catch(() => undefined);
		}
	}

	private logStatus(entry: WatchEntry, text: string): void {
		void this.registry.appendLog(entry.definition.id, `[status]: ${text}`).catch(() => undefined);
	}
}
