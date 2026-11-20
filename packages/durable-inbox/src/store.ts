import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, basename, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type {
	Message,
	MessageMetadata,
	ReadMessageOptions,
	ReadReceipt,
	WriteMessageInput,
} from "./types.ts";

const CHANNEL_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function requireText(value: string, label: string, maximum: number): string {
	const normalized = value.trim();
	if (!normalized) throw new Error(`${label} must not be empty`);
	if (value.length > maximum) throw new Error(`${label} exceeds ${maximum} characters`);
	return normalized;
}

function requireChannel(value: string): string {
	if (!CHANNEL_PATTERN.test(value)) {
		throw new Error("channel must match [a-z0-9][a-z0-9_-]{0,63}");
	}
	return value;
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

export async function readJson<T>(path: string): Promise<T> {
	return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function writeAtomic(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
	try {
		await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
		await rename(temporary, path);
	} finally {
		if (await exists(temporary)) await unlink(temporary);
	}
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
	await writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Advisory lock: a lock file created exclusively, removed on completion.
 * Stale locks (creator died) are reclaimed after 30 seconds.
 */
export async function withLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const lockPath = `${path}.lock`;
	const started = Date.now();
	let handle;
	while (!handle) {
		try {
			handle = await open(lockPath, "wx", 0o600);
			await handle.writeFile(`${process.pid}\n`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (Date.now() - started > 5_000) throw new Error(`timed out locking ${basename(path)}`);
			try {
				const lockStat = await stat(lockPath);
				if (Date.now() - lockStat.mtimeMs > 30_000) await unlink(lockPath);
			} catch (lockError) {
				if ((lockError as NodeJS.ErrnoException).code !== "ENOENT") throw lockError;
			}
			await delay(25);
		}
	}
	try {
		return await operation();
	} finally {
		await handle.close();
		if (await exists(lockPath)) await unlink(lockPath);
	}
}

export function messageMarkdown(metadata: MessageMetadata, body: string): string {
	return [
		"---",
		`id: ${JSON.stringify(metadata.id)}`,
		`from: ${JSON.stringify(metadata.from)}`,
		`to: ${JSON.stringify(metadata.to)}`,
		`channel: ${JSON.stringify(metadata.channel)}`,
		`created_at: ${JSON.stringify(metadata.created_at)}`,
		`reply_to: ${JSON.stringify(metadata.reply_to)}`,
		...(metadata.delivery ? [`delivery: ${JSON.stringify(metadata.delivery)}`] : []),
		"---",
		body,
		"",
	].join("\n");
}

export function parseMessage(path: string, raw: string, readAt: string | null): Message {
	const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
	if (!match?.[1] || match[2] === undefined) throw new Error(`invalid message format: ${path}`);
	const values: Record<string, unknown> = {};
	for (const line of match[1].split("\n")) {
		const separator = line.indexOf(": ");
		if (separator < 0) throw new Error(`invalid message metadata: ${path}`);
		values[line.slice(0, separator)] = JSON.parse(line.slice(separator + 2));
	}
	const metadata = values as unknown as MessageMetadata;
	if (!metadata.id || !metadata.from || !metadata.created_at) {
		throw new Error(`incomplete message metadata: ${path}`);
	}
	return { metadata, body: match[2], path, read_at: readAt };
}

function normalizeReadOptions(options: ReadMessageOptions): {
	since: number | undefined;
	limit: number;
} {
	let since: number | undefined;
	if (options.since !== undefined) {
		since = Date.parse(options.since);
		if (Number.isNaN(since)) throw new Error("since must be an ISO timestamp");
	}
	const limit = options.limit ?? 50;
	if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
		throw new Error("limit must be an integer from 1 to 200");
	}
	return { since, limit };
}

function filterAndLimit(messages: Message[], options: ReadMessageOptions): Message[] {
	const normalized = normalizeReadOptions(options);
	return messages
		.filter((message) => normalized.since === undefined || Date.parse(message.metadata.created_at) > normalized.since)
		.sort((a, b) => a.metadata.created_at.localeCompare(b.metadata.created_at) || a.metadata.id.localeCompare(b.metadata.id))
		.slice(-normalized.limit);
}

/**
 * Filesystem-backed durable message store. One file per message, atomic
 * writes, no database. Identity validation (what a "recipient" or "sender"
 * must look like) is deliberately left to consumers; this class only enforces
 * storage-layout constraints (channel names, body limits, read semantics).
 */
export class MessageStore {
	readonly root: string;

	constructor(root: string) {
		this.root = resolve(root);
	}

	async withDeliveryLock<T>(recipient: string, operation: () => Promise<T>): Promise<T> {
		return withLock(join(this.root, "locks", "deliveries", recipient), operation);
	}

	private async writeMessage(input: WriteMessageInput, metadata: MessageMetadata, path: string): Promise<Message> {
		requireText(input.body, "message", 100_000);
		await writeAtomic(path, messageMarkdown(metadata, input.body));
		return { metadata, body: `${input.body}\n`, path, read_at: null };
	}

	async sendDirect(input: WriteMessageInput & { to: string }): Promise<Message> {
		if (input.channel !== undefined) throw new Error("direct messages cannot specify a channel");
		if (input.delivery !== undefined && input.delivery !== "inline" && input.delivery !== "reference") {
			throw new Error("delivery must be inline or reference");
		}
		const metadata: MessageMetadata = {
			id: randomUUID(),
			from: input.from,
			to: input.to,
			channel: null,
			created_at: new Date().toISOString(),
			reply_to: input.replyTo ?? null,
			delivery: input.delivery ?? "inline",
		};
		return this.writeMessage(input, metadata, join(this.root, "inboxes", input.to, `${metadata.id}.md`));
	}

	async postChannel(input: WriteMessageInput & { channel: string }): Promise<Message> {
		const channel = requireChannel(input.channel);
		if (input.to !== undefined) throw new Error("channel messages cannot specify a recipient");
		const now = new Date();
		const metadata: MessageMetadata = {
			id: randomUUID(),
			from: input.from,
			to: null,
			channel,
			created_at: now.toISOString(),
			reply_to: input.replyTo ?? null,
		};
		const stamp = metadata.created_at.replace(/[-:]/g, "");
		const day = metadata.created_at.slice(0, 10).replace(/-/g, "/");
		const path = join(this.root, "comm_channels", channel, day, `${stamp}_${metadata.id}.md`);
		return this.writeMessage(input, metadata, path);
	}

	private async readMessage(path: string): Promise<Message> {
		const receiptPath = `${path}.read.json`;
		const readAt = (await exists(receiptPath))
			? (await readJson<ReadReceipt>(receiptPath)).read_at
			: null;
		return parseMessage(path, await readFile(path, "utf8"), readAt);
	}

	async readInbox(recipient: string, options: ReadMessageOptions = {}): Promise<Message[]> {
		const directory = join(this.root, "inboxes", recipient);
		if (options.messageId) {
			const message = await this.readMessage(join(directory, `${options.messageId}.md`));
			return [message];
		}
		if (!(await exists(directory))) return [];
		const messages: Message[] = [];
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if (entry.isFile() && entry.name.endsWith(".md")) {
				messages.push(await this.readMessage(join(directory, entry.name)));
			}
		}
		return filterAndLimit(messages, options);
	}

	async readChannel(channel: string, options: ReadMessageOptions = {}): Promise<Message[]> {
		const directory = join(this.root, "comm_channels", requireChannel(channel));
		if (!(await exists(directory))) return [];
		const messages: Message[] = [];
		for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
			messages.push(await this.readMessage(join(entry.parentPath, entry.name)));
		}
		return filterAndLimit(messages, options);
	}

	async markRead(recipient: string, messageId: string): Promise<ReadReceipt> {
		const [message] = await this.readInbox(recipient, { messageId });
		if (!message || message.metadata.to !== recipient) throw new Error("message is not in this agent's inbox");
		const receiptPath = `${message.path}.read.json`;
		if (await exists(receiptPath)) return readJson<ReadReceipt>(receiptPath);
		const receipt: ReadReceipt = { message_id: messageId, agent_id: recipient, read_at: new Date().toISOString() };
		await writeJsonAtomic(receiptPath, receipt);
		return receipt;
	}

	async getMessageStatus(requesterId: string, messageId: string) {
		const inboxRoot = join(this.root, "inboxes");
		if (await exists(inboxRoot)) {
			for (const entry of await readdir(inboxRoot, { withFileTypes: true })) {
				if (!entry.isDirectory()) continue;
				const path = join(inboxRoot, entry.name, `${messageId}.md`);
				if (!(await exists(path))) continue;
				const message = await this.readMessage(path);
				if (message.metadata.from !== requesterId) {
					throw new Error("only the sender can inspect this message's read status");
				}
				return {
					message_id: messageId,
					from: message.metadata.from,
					to: message.metadata.to,
					created_at: message.metadata.created_at,
					read: message.read_at !== null,
					read_at: message.read_at,
				};
			}
		}
		throw new Error("message not found");
	}
}
