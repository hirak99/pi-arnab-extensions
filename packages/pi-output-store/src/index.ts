import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { randomUUID } from "node:crypto";

export const DEFAULT_OUTPUT_SEGMENT_BYTES = 10 * 1024 * 1024;

interface OutputState {
	version: 1;
	omitted_lines: number;
	current_lines: number;
	rotated_lines: number;
}

interface FileLineStats {
	bytes: number;
	lines: number;
	endsWithNewline: boolean;
}

export interface OutputRead {
	path: string;
	text: string;
	totalBytes: number;
	bytesRead: number;
	truncated: boolean;
	omittedLines: number;
}

export interface OutputLinesRead {
	path: string;
	lines: string[];
	omittedLines: number;
}

function safeSegment(value: string): string {
	const sanitized = value.replace(/[^a-zA-Z0-9._-]/g, "_");
	return sanitized || "user";
}

export function temporaryOutputBase(): string {
	return join(tmpdir(), `pi-${safeSegment(userInfo().username)}`);
}

export function temporaryOutputRoot(category: string): string {
	if (!/^[a-zA-Z0-9._-]+$/.test(category)) throw new Error("Invalid temporary output category");
	return join(temporaryOutputBase(), category);
}

async function ensurePrivateDirectory(path: string): Promise<void> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	const info = await lstat(path);
	if (!info.isDirectory()) throw new Error(`Temporary output path is not a directory: ${path}`);
	if (process.getuid && info.uid !== process.getuid()) {
		throw new Error(`Temporary output directory has a different owner: ${path}`);
	}
	if ((info.mode & 0o777) !== 0o700) await chmod(path, 0o700);
}

async function ensureOutputParent(directory: string): Promise<void> {
	const base = temporaryOutputBase();
	const suffix = relative(base, directory);
	if (suffix.startsWith("..") || isAbsolute(suffix)) {
		await mkdir(directory, { recursive: true, mode: 0o700 });
		return;
	}
	await ensurePrivateDirectory(base);
	let current = base;
	if (!suffix) return;
	for (const segment of suffix.split(/[\\/]/)) {
		current = join(current, segment);
		await ensurePrivateDirectory(current);
	}
}

export async function ensureTemporaryOutputRoot(category: string): Promise<string> {
	const base = temporaryOutputBase();
	const root = temporaryOutputRoot(category);
	await ensurePrivateDirectory(base);
	await ensurePrivateDirectory(root);
	return root;
}

function rotatedPath(path: string): string {
	return `${path}.1`;
}

function statePath(path: string): string {
	return `${path}.state.json`;
}

async function countLines(path: string): Promise<FileLineStats> {
	try {
		const info = await stat(path);
		if (info.size === 0) return { bytes: 0, lines: 0, endsWithNewline: true };
		let lines = 0;
		let lastByte = 10;
		for await (const chunk of createReadStream(path)) {
			const buffer = chunk as Buffer;
			for (const byte of buffer) if (byte === 10) lines++;
			lastByte = buffer[buffer.length - 1] ?? 10;
		}
		return { bytes: info.size, lines: lines + (lastByte === 10 ? 0 : 1), endsWithNewline: lastByte === 10 };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { bytes: 0, lines: 0, endsWithNewline: true };
		throw error;
	}
}

async function readState(path: string): Promise<OutputState> {
	try {
		const raw = JSON.parse(await readFile(statePath(path), "utf8")) as Partial<OutputState>;
		return {
			version: 1,
			omitted_lines: Number.isSafeInteger(raw.omitted_lines) && (raw.omitted_lines ?? -1) >= 0 ? raw.omitted_lines! : 0,
			current_lines: Number.isSafeInteger(raw.current_lines) && (raw.current_lines ?? -1) >= 0 ? raw.current_lines! : 0,
			rotated_lines: Number.isSafeInteger(raw.rotated_lines) && (raw.rotated_lines ?? -1) >= 0 ? raw.rotated_lines! : 0,
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) {
			return { version: 1, omitted_lines: 0, current_lines: 0, rotated_lines: 0 };
		}
		throw error;
	}
}

async function writeState(path: string, state: OutputState): Promise<void> {
	const temporary = `${statePath(path)}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
	await rename(temporary, statePath(path));
}

async function readIfPresent(path: string): Promise<Buffer> {
	try {
		return await readFile(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return Buffer.alloc(0);
		throw error;
	}
}

export class BoundedOutput {
	readonly path: string;
	readonly maxSegmentBytes: number;
	private handle: FileHandle | null = null;
	private initialized = false;
	private currentBytes = 0;
	private endsWithNewline = true;
	private state: OutputState = { version: 1, omitted_lines: 0, current_lines: 0, rotated_lines: 0 };
	private queue: Promise<void> = Promise.resolve();

	constructor(path: string, options: { maxSegmentBytes?: number } = {}) {
		if (!basename(path) || basename(path) === "." || basename(path) === "..") throw new Error("Invalid output path");
		this.path = path;
		this.maxSegmentBytes = options.maxSegmentBytes ?? DEFAULT_OUTPUT_SEGMENT_BYTES;
		if (!Number.isSafeInteger(this.maxSegmentBytes) || this.maxSegmentBytes < 1) throw new Error("maxSegmentBytes must be a positive integer");
	}

	private enqueue(operation: () => Promise<void>): Promise<void> {
		const result = this.queue.then(operation);
		this.queue = result.catch(() => undefined);
		return result;
	}

	private async initialize(): Promise<void> {
		if (this.initialized) return;
		await ensureOutputParent(dirname(this.path));
		const previous = await readState(this.path);
		const [current, rotated] = await Promise.all([countLines(this.path), countLines(rotatedPath(this.path))]);
		this.currentBytes = current.bytes;
		this.endsWithNewline = current.endsWithNewline;
		this.state = {
			version: 1,
			omitted_lines: previous.omitted_lines,
			current_lines: current.lines,
			rotated_lines: rotated.lines,
		};
		this.handle = await open(this.path, "a", 0o600);
		this.initialized = true;
	}

	private async closeCurrent(): Promise<void> {
		const handle = this.handle;
		this.handle = null;
		this.initialized = false;
		if (handle) await handle.close();
	}

	private async rotate(): Promise<void> {
		await this.closeCurrent();
		const omitted = this.state.rotated_lines;
		await rm(rotatedPath(this.path), { force: true });
		await rename(this.path, rotatedPath(this.path));
		this.state = {
			version: 1,
			omitted_lines: this.state.omitted_lines + omitted,
			current_lines: 0,
			rotated_lines: this.state.current_lines,
		};
		this.currentBytes = 0;
		this.endsWithNewline = true;
		await writeState(this.path, this.state);
		// Keep the advertised current path present even at an exact byte boundary.
		await this.initialize();
	}

	private async writeChunk(chunk: Buffer): Promise<void> {
		if (!this.handle) throw new Error("Output file is not open");
		let offset = 0;
		while (offset < chunk.length) {
			const result = await this.handle.write(chunk, offset, chunk.length - offset);
			if (result.bytesWritten === 0) throw new Error("Could not append output");
			offset += result.bytesWritten;
		}
		let newlines = 0;
		for (const byte of chunk) if (byte === 10) newlines++;
		const startsLine = this.currentBytes === 0 || this.endsWithNewline;
		const endsWithNewline = chunk[chunk.length - 1] === 10;
		this.state.current_lines += newlines + (startsLine && !endsWithNewline ? 1 : 0);
		this.currentBytes += chunk.length;
		this.endsWithNewline = endsWithNewline;
	}

	private async appendNow(value: string | Buffer): Promise<void> {
		const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
		if (buffer.length === 0) return;
		let offset = 0;
		while (offset < buffer.length) {
			await this.initialize();
			if (this.currentBytes >= this.maxSegmentBytes) await this.rotate();
			await this.initialize();
			const length = Math.min(buffer.length - offset, this.maxSegmentBytes - this.currentBytes);
			const chunk = buffer.subarray(offset, offset + length);
			await this.writeChunk(chunk);
			offset += length;
		}
	}

	append(value: string | Buffer): Promise<void> {
		return this.enqueue(() => this.appendNow(value));
	}

	open(): Promise<void> {
		return this.enqueue(() => this.initialize());
	}

	flush(): Promise<void> {
		return this.queue;
	}

	close(): Promise<void> {
		return this.enqueue(() => this.closeCurrent());
	}

	async delete(): Promise<void> {
		await this.close();
		await deleteOutput(this.path);
	}
}

export async function readOutput(path: string, options: { maxBytes?: number; tail?: boolean } = {}): Promise<OutputRead> {
	const maxBytes = options.maxBytes ?? 50 * 1024;
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("maxBytes must be a positive integer");
	const [rotated, current, state] = await Promise.all([readIfPresent(rotatedPath(path)), readIfPresent(path), readState(path)]);
	const combined = Buffer.concat([rotated, current]);
	const length = Math.min(combined.length, maxBytes);
	const start = options.tail === false ? 0 : combined.length - length;
	const selected = combined.subarray(start, start + length);
	return {
		path,
		text: selected.toString("utf8"),
		totalBytes: combined.length,
		bytesRead: selected.length,
		truncated: combined.length > selected.length,
		omittedLines: state.omitted_lines,
	};
}

export async function readOutputLines(path: string, maxLines = 50): Promise<OutputLinesRead> {
	if (!Number.isSafeInteger(maxLines) || maxLines < 1) throw new Error("maxLines must be a positive integer");
	const result = await readOutput(path, { maxBytes: DEFAULT_OUTPUT_SEGMENT_BYTES * 2, tail: false });
	const lines = result.text.length === 0 ? [] : result.text.split("\n");
	if (result.text.endsWith("\n")) lines.pop();
	return { path, lines: lines.slice(-maxLines), omittedLines: result.omittedLines };
}

export async function deleteOutput(path: string): Promise<void> {
	await Promise.all([
		rm(path, { force: true }),
		rm(rotatedPath(path), { force: true }),
		rm(statePath(path), { force: true }),
	]);
}
