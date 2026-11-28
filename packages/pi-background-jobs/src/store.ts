import { mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

import { readJson, writeJsonAtomic } from "pi-durable-inbox";
import { deleteOutput, readOutput } from "pi-output-store";

import { DEFAULT_LOG_BYTES, MAX_LOG_BYTES, type JobLogs, type JobTask } from "./types.ts";

export class JobStore {
	readonly root: string;
	readonly outputRoot: string;

	constructor(root: string, outputRoot = root) {
		this.root = root;
		this.outputRoot = outputRoot;
	}

	private metadataPath(id: string): string {
		return join(this.root, `${id}.json`);
	}

	outputPath(id: string): string {
		return join(this.outputRoot, `${id}.output`);
	}

	async prepare(): Promise<void> {
		await mkdir(this.root, { recursive: true, mode: 0o700 });
		await mkdir(this.outputRoot, { recursive: true, mode: 0o700 });
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
		const result = await readOutput(task.output_path, { maxBytes, tail });
		return {
			task,
			text: result.text,
			path: result.path,
			tail,
			bytesRead: result.bytesRead,
			truncated: result.truncated,
			...(result.omittedLines > 0 ? { omitted_lines: result.omittedLines } : {}),
		};
	}

	async remove(task: JobTask): Promise<void> {
		// Remove output first and metadata last, so a failed output deletion does
		// not erase the record needed to inspect or retry the cleanup.
		await deleteOutput(task.output_path);
		try {
			await unlink(this.metadataPath(task.id));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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
