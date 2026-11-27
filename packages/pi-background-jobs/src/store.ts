import { mkdir, open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { readJson, writeJsonAtomic } from "pi-durable-inbox";

import { DEFAULT_LOG_BYTES, MAX_LOG_BYTES, type JobLogs, type JobTask } from "./types.ts";

export class JobStore {
	readonly root: string;

	constructor(root: string) {
		this.root = root;
	}

	private metadataPath(id: string): string {
		return join(this.root, `${id}.json`);
	}

	outputPath(id: string): string {
		return join(this.root, `${id}.output`);
	}

	async prepare(): Promise<void> {
		await mkdir(this.root, { recursive: true, mode: 0o700 });
	}

	async save(task: JobTask): Promise<void> {
		await writeJsonAtomic(this.metadataPath(task.id), task);
	}

	async restore(sessionId: string): Promise<JobTask[]> {
		let entries;
		try {
			entries = await readdir(this.root, { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const tasks: JobTask[] = [];
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
			const task = await readJson<JobTask>(join(this.root, entry.name));
			if (task.session_id !== sessionId) continue;
			if (task.status === "running") {
				task.status = "failed";
				task.pid = null;
				task.completed_at ??= new Date().toISOString();
				task.error = "Pi exited before the job completed; the process was not adopted after restart";
				task.deadline_at = null;
				await this.save(task);
			}
			tasks.push(task);
		}
		return tasks.sort((a, b) => b.created_at.localeCompare(a.created_at));
	}

	async readLogs(task: JobTask, tail: boolean, requestedBytes?: number): Promise<JobLogs> {
		const maxBytes = requestedBytes ?? DEFAULT_LOG_BYTES;
		if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_LOG_BYTES) {
			throw new Error(`maxBytes must be an integer from 1 to ${MAX_LOG_BYTES}`);
		}
		let size: number;
		try {
			size = (await stat(task.output_path)).size;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return { task, text: "", path: task.output_path, tail, bytesRead: 0, truncated: false };
			}
			throw error;
		}
		const length = Math.min(size, maxBytes);
		const start = tail ? size - length : 0;
		const handle = await open(task.output_path, "r");
		try {
			const buffer = Buffer.alloc(length);
			await handle.read(buffer, 0, length, start);
			return {
				task,
				text: buffer.toString("utf8"),
				path: task.output_path,
				tail,
				bytesRead: length,
				truncated: size > length,
			};
		} finally {
			await handle.close();
		}
	}

	async readMetadata(id: string): Promise<JobTask | undefined> {
		try {
			return await readJson<JobTask>(this.metadataPath(id));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}
}

export function jobsDirectory(root: string, sessionId: string): string {
	return join(root, sessionId);
}
