import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";

import { JobStore, jobsDirectory } from "./store.ts";
import type { JobStatus, JobTask } from "./types.ts";

export type DeliverJob = (task: JobTask) => void;

interface JobEntry {
	task: JobTask;
	child: ChildProcess | null;
	log: WriteStream | null;
	timeout: NodeJS.Timeout | null;
	killTimer: NodeJS.Timeout | null;
	done: Promise<void>;
	settle: () => void;
	saveChain: Promise<void>;
	finished: boolean;
	notified: boolean;
	seen: boolean;
	requestedStatus: "failed" | "killed" | null;
	terminationError: string | null;
}

export interface StartJobInput {
	name: string;
	command: string;
	cwd: string;
	timeoutSeconds?: number | undefined;
}

function newEntry(task: JobTask, historical = false): JobEntry {
	let settle: () => void = () => {};
	const done = new Promise<void>((resolve) => { settle = resolve; });
	if (historical) settle();
	return {
		task,
		child: null,
		log: null,
		timeout: null,
		killTimer: null,
		done,
		settle,
		saveChain: Promise.resolve(),
		finished: historical,
		notified: historical,
		seen: historical,
		requestedStatus: null,
		terminationError: null,
	};
}

export class JobSupervisor {
	readonly root: string;
	private readonly killGraceMs: number;
	private store: JobStore | undefined;
	private sessionId: string | undefined;
	private deliver: DeliverJob | undefined;
	private onStateChange: (() => void) | undefined;
	private onError: ((error: Error) => void) | undefined;
	private readonly entries = new Map<string, JobEntry>();

	constructor(
		root: string,
		deliver?: DeliverJob,
		onStateChange?: () => void,
		onError?: (error: Error) => void,
		killGraceMs = 2_000,
	) {
		this.root = root;
		this.killGraceMs = killGraceMs;
		this.deliver = deliver;
		this.onStateChange = onStateChange;
		this.onError = onError;
	}

	async restore(sessionId: string): Promise<void> {
		this.sessionId = sessionId;
		this.store = new JobStore(jobsDirectory(this.root, sessionId));
		await this.store.prepare();
		const tasks = await this.store.restore(sessionId);
		this.entries.clear();
		for (const task of tasks) this.entries.set(task.id, newEntry(task, true));
		this.onStateChange?.();
	}

	rebind(deliver: DeliverJob, onStateChange: () => void, onError: (error: Error) => void): void {
		this.deliver = deliver;
		this.onStateChange = onStateChange;
		this.onError = onError;
		this.onStateChange();
		for (const entry of this.entries.values()) {
			if (entry.finished && !entry.notified) this.publish(entry);
		}
	}

	detach(): void {
		this.deliver = undefined;
		this.onStateChange = undefined;
		this.onError = undefined;
	}

	list(sessionId: string): JobTask[] {
		return [...this.entries.values()]
			.map((entry) => entry.task)
			.filter((task) => task.session_id === sessionId)
			.sort((a, b) => b.created_at.localeCompare(a.created_at))
			.map((task) => ({ ...task }));
	}

	resolve(idOrPrefix: string, sessionId: string): JobEntry {
		const prefix = idOrPrefix.trim();
		if (!prefix) throw new Error("taskId is required");
		const matches = [...this.entries.values()].filter((entry) =>
			entry.task.session_id === sessionId && entry.task.id.startsWith(prefix));
		if (matches.length === 0) throw new Error(`job not found: ${prefix}`);
		if (matches.length > 1) throw new Error(`job ID prefix is ambiguous: ${prefix}`);
		return matches[0]!;
	}

	async readLogs(idOrPrefix: string, sessionId: string, tail: boolean, maxBytes?: number) {
		if (!this.store) throw new Error("job session is not initialized");
		const entry = this.resolve(idOrPrefix, sessionId);
		return this.store.readLogs(entry.task, tail, maxBytes);
	}

	markSeen(sessionId: string): void {
		for (const entry of this.entries.values()) {
			if (entry.task.session_id === sessionId) entry.seen = true;
		}
		this.onStateChange?.();
	}

	unseenFinished(sessionId: string): JobTask[] {
		return this.list(sessionId).filter((task) => {
			const entry = this.entries.get(task.id);
			return task.status !== "running" && entry?.seen === false;
		});
	}

	async start(sessionId: string, input: StartJobInput): Promise<JobTask> {
		if (!this.store || this.sessionId !== sessionId) throw new Error("job session is not initialized");
		const name = input.name.trim();
		if (!name) throw new Error("name must not be empty");
		if (name.length > 80) throw new Error("name exceeds 80 characters");
		if (!input.command.trim()) throw new Error("command must not be empty");
		if (input.command.length > 100_000) throw new Error("command exceeds 100000 characters");
		const timeoutSeconds = input.timeoutSeconds;
		if (timeoutSeconds !== undefined && (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1)) {
			throw new Error("timeoutSeconds must be an integer of at least 1");
		}
		const id = randomUUID();
		const createdAt = new Date().toISOString();
		const task: JobTask = {
			id,
			session_id: sessionId,
			name,
			command: input.command,
			status: "running",
			pid: null,
			output_path: this.store.outputPath(id),
			created_at: createdAt,
			completed_at: null,
			exit_code: null,
			signal: null,
			error: null,
			timeout_seconds: timeoutSeconds ?? null,
			deadline_at: timeoutSeconds ? new Date(Date.now() + timeoutSeconds * 1000).toISOString() : null,
		};
		const entry = newEntry(task);
		this.entries.set(id, entry);
		try {
			await this.store.save(task);
		} catch (error) {
			this.entries.delete(id);
			throw error;
		}
		this.onStateChange?.();

		entry.log = createWriteStream(task.output_path, { flags: "a", mode: 0o600 });
		entry.log.on("error", (error) => {
			entry.requestedStatus = "failed";
			entry.terminationError = `Output log failed: ${error.message}`;
			this.signal(entry, "SIGTERM");
		});
		let child: ChildProcess;
		try {
			child = spawn("/bin/bash", ["-c", input.command], {
				cwd: input.cwd,
				env: process.env,
				detached: process.platform !== "win32",
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (error) {
			entry.terminationError = error instanceof Error ? error.message : String(error);
			await this.finish(entry, null, null);
			return { ...entry.task };
		}
		entry.child = child;
		task.pid = child.pid ?? null;
		this.persist(entry);
		child.stdout?.pipe(entry.log, { end: false });
		child.stderr?.pipe(entry.log, { end: false });
		child.once("error", (error) => {
			entry.requestedStatus = "failed";
			entry.terminationError = error.message;
			if (child.pid === undefined) queueMicrotask(() => void this.finish(entry, null, null));
		});
		child.once("close", (code, signal) => {
			void this.finish(entry, code, signal);
		});
		if (task.deadline_at) {
			const remaining = Date.parse(task.deadline_at) - Date.now();
			entry.timeout = setTimeout(() => {
				entry.requestedStatus = "failed";
				entry.terminationError = `Timed out after ${task.timeout_seconds} seconds`;
				this.signal(entry, "SIGTERM");
			}, Math.max(0, remaining));
		}
		return { ...task };
	}

	async kill(idOrPrefix: string, sessionId: string): Promise<JobTask> {
		const entry = this.resolve(idOrPrefix, sessionId);
		if (entry.task.status !== "running" || entry.finished) throw new Error("job is not running");
		entry.requestedStatus = "killed";
		this.signal(entry, "SIGTERM");
		entry.killTimer = setTimeout(() => this.signal(entry, "SIGKILL"), this.killGraceMs);
		await entry.done;
		return { ...entry.task };
	}

	async shutdown(): Promise<void> {
		this.detach();
		const running = [...this.entries.values()].filter((entry) => !entry.finished && entry.task.status === "running");
		await Promise.all(running.map(async (entry) => {
			entry.requestedStatus = "killed";
			entry.terminationError = "Stopped during Pi shutdown";
			this.signal(entry, "SIGTERM");
			entry.killTimer = setTimeout(() => this.signal(entry, "SIGKILL"), this.killGraceMs);
			await entry.done;
		}));
	}

	private persist(entry: JobEntry): void {
		entry.saveChain = entry.saveChain
			.catch(() => undefined)
			.then(() => this.store?.save(entry.task) ?? Promise.resolve());
		void entry.saveChain.catch((error) => {
			this.onError?.(error instanceof Error ? error : new Error(String(error)));
		});
	}

	private signal(entry: JobEntry, signal: NodeJS.Signals): void {
		const child = entry.child;
		if (!child || entry.finished) return;
		try {
			if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, signal);
			else child.kill(signal);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
			try {
				child.kill(signal);
			} catch (fallbackError) {
				this.onError?.(fallbackError instanceof Error ? fallbackError : new Error(String(fallbackError)));
			}
		}
	}

	private async finish(entry: JobEntry, code: number | null, signal: NodeJS.Signals | null): Promise<void> {
		if (entry.finished) return;
		entry.finished = true;
		if (entry.timeout) clearTimeout(entry.timeout);
		if (entry.killTimer) clearTimeout(entry.killTimer);
		entry.timeout = null;
		entry.killTimer = null;
		const status: JobStatus = entry.requestedStatus ?? (code === 0 ? "completed" : "failed");
		entry.task.status = status;
		entry.task.completed_at = new Date().toISOString();
		entry.task.exit_code = code;
		entry.task.signal = signal;
		entry.task.error = entry.terminationError ?? (status === "failed" && signal ? `Terminated by ${signal}` : null);
		entry.task.pid = null;
		entry.task.deadline_at = null;
		entry.seen = false;
		try {
			if (entry.log) {
				await new Promise<void>((resolve) => entry.log!.end(resolve));
			}
			await entry.saveChain;
			await this.store?.save(entry.task);
		} catch (error) {
			this.onError?.(error instanceof Error ? error : new Error(String(error)));
		}
		try {
			this.onStateChange?.();
		} catch (error) {
			this.onError?.(error instanceof Error ? error : new Error(String(error)));
		}
		try {
			this.publish(entry);
		} finally {
			entry.settle();
		}
	}

	private publish(entry: JobEntry): void {
		if (!this.deliver || entry.notified) return;
		try {
			this.deliver({ ...entry.task });
			entry.notified = true;
		} catch (error) {
			this.onError?.(error instanceof Error ? error : new Error(String(error)));
		}
	}
}
