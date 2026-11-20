import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

import type { WatchDefinition, WatchRuntimeState } from "./types.ts";

/**
 * Durable registry: definitions and runtime state are plain JSON files under
 * the watch root, so `watch_list` works even after a Pi restart (definitions
 * persist; running processes do not — v1 by design).
 */
export class WatchRegistry {
	readonly root: string;

	constructor(root: string) {
		this.root = root;
	}

	get definitionsDir(): string {
		return join(this.root, "registry");
	}

	get stateDir(): string {
		return join(this.root, "state");
	}

	get logsDir(): string {
		return join(this.root, "logs");
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

	/** Remove the definition; logs and script state are kept for forensics. */
	async remove(id: string): Promise<void> {
		await unlink(this.definitionPath(id)).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
		await unlink(this.statePath(id)).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
	}

	async appendLog(id: string, line: string): Promise<void> {
		await mkdir(this.logsDir, { recursive: true, mode: 0o700 });
		await writeFile(this.logPath(id), `${line}\n`, { encoding: "utf8", flag: "a", mode: 0o600 });
	}

	async readLogTail(id: string, maxLines: number): Promise<string[]> {
		let raw: string;
		try {
			raw = await readFile(this.logPath(id), "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const lines = raw.split("\n");
		if (lines.at(-1) === "") lines.pop();
		return lines.slice(-maxLines);
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
