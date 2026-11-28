import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

import { BoundedOutput, deleteOutput, readOutputLines } from "pi-output-store";

import type { WatchDefinition, WatchRuntimeState } from "./types.ts";

/**
 * Durable registry: definitions and runtime state are plain JSON files under
 * the watch root. Cold restore is exact-session scoped; running state records
 * the intent to auto-resume after a full Pi restart.
 */
export class WatchRegistry {
	readonly root: string;
	readonly logsDir: string;
	private readonly maxSegmentBytes: number | undefined;
	private readonly writers = new Map<string, BoundedOutput>();
	private readonly removed = new Set<string>();

	constructor(root: string, logsDir = join(root, "logs"), maxSegmentBytes?: number) {
		this.root = root;
		this.logsDir = logsDir;
		this.maxSegmentBytes = maxSegmentBytes;
	}

	get definitionsDir(): string {
		return join(this.root, "registry");
	}

	get stateDir(): string {
		return join(this.root, "state");
	}

	definitionPath(id: string): string {
		return join(this.definitionsDir, `${id}.json`);
	}

	statePath(id: string): string {
		return join(this.stateDir, `${id}.json`);
	}

	logPath(id: string): string {
		return join(this.logsDir, `${id}.log`);
	}

	private legacyLogPath(id: string): string {
		return join(this.root, "logs", `${id}.log`);
	}

	/** Per-watch private state directory, exposed to scripts as $WATCH_STATE. */
	scriptStatePath(id: string): string {
		return join(this.stateDir, id);
	}

	async loadDefinition(id: string): Promise<WatchDefinition | undefined> {
		try {
			return JSON.parse(await readFile(this.definitionPath(id), "utf8")) as WatchDefinition;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}

	async loadState(id: string): Promise<WatchRuntimeState | undefined> {
		try {
			return JSON.parse(await readFile(this.statePath(id), "utf8")) as WatchRuntimeState;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}

	async saveDefinition(definition: WatchDefinition): Promise<void> {
		await writeJsonAtomic(this.definitionPath(definition.id), definition);
	}

	async saveState(id: string, state: WatchRuntimeState): Promise<void> {
		await writeJsonAtomic(this.statePath(id), state);
	}

	async listDefinitions(): Promise<WatchDefinition[]> {
		let entries: string[] = [];
		try {
			entries = await readdir(this.definitionsDir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			return [];
		}
		const definitions: WatchDefinition[] = [];
		for (const entry of entries.sort()) {
			if (!entry.endsWith(".json")) continue;
			const definition = await this.loadDefinition(entry.slice(0, -5));
			if (definition) definitions.push(definition);
		}
		return definitions;
	}

	/** Remove durable definitions/state and every temporary output artifact. */
	async remove(id: string): Promise<void> {
		this.removed.add(id);
		await this.closeLog(id);
		await deleteOutput(this.logPath(id));
		await unlink(this.legacyLogPath(id)).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
		await unlink(this.definitionPath(id)).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
		await unlink(this.statePath(id)).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
		this.writers.delete(id);
	}

	private writer(id: string): BoundedOutput {
		let writer = this.writers.get(id);
		if (!writer) {
			writer = new BoundedOutput(this.logPath(id), this.maxSegmentBytes === undefined ? {} : { maxSegmentBytes: this.maxSegmentBytes });
			this.writers.set(id, writer);
		}
		return writer;
	}

	async appendLog(id: string, line: string): Promise<void> {
		if (this.removed.has(id)) return;
		await this.writer(id).append(`${line}\n`);
	}

	async readLog(id: string, maxLines: number) {
		await this.writers.get(id)?.flush();
		const result = await readOutputLines(this.logPath(id), maxLines);
		if (result.lines.length > 0) return result;
		const legacy = await readOutputLines(this.legacyLogPath(id), maxLines);
		return legacy.lines.length > 0 ? legacy : result;
	}

	async readLogTail(id: string, maxLines: number): Promise<string[]> {
		return (await this.readLog(id, maxLines)).lines;
	}

	async closeLog(id: string): Promise<void> {
		await this.writers.get(id)?.close();
	}

	async closeLogs(): Promise<void> {
		await Promise.all([...this.writers.values()].map((writer) => writer.close()));
	}
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
		await rename(temporary, path);
	} finally {
		await unlink(temporary).catch(() => undefined);
	}
}

export { writeJsonAtomic };
