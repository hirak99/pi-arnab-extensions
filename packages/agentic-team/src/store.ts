import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, basename, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type {
	AgentRegistration,
	ReadMessageOptions,
	RegistrationInput,
	TeamMessage,
	TeamMessageMetadata,
	ReadReceipt,
	WriteMessageInput,
} from "./types.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHANNEL_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function requireUuid(value: string, label: string): void {
	if (!UUID_PATTERN.test(value)) throw new Error(`${label} must be a UUID`);
}

function requireText(value: string, label: string, maximum: number): string {
	const normalized = value.trim();
	if (!normalized) throw new Error(`${label} must not be empty`);
	if (value.length > maximum) throw new Error(`${label} exceeds ${maximum} characters`);
	return value;
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

async function readJson<T>(path: string): Promise<T> {
	return JSON.parse(await readFile(path, "utf8")) as T;
}

async function writeAtomic(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
	try {
		await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
		await rename(temporary, path);
	} finally {
		if (await exists(temporary)) await unlink(temporary);
	}
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
	await writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function withRegistryLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
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

function messageMarkdown(metadata: TeamMessageMetadata, body: string): string {
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

function parseMessage(path: string, raw: string, readAt: string | null): TeamMessage {
	const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
	if (!match?.[1] || match[2] === undefined) throw new Error(`invalid message format: ${path}`);
	const values: Record<string, unknown> = {};
	for (const line of match[1].split("\n")) {
		const separator = line.indexOf(": ");
		if (separator < 0) throw new Error(`invalid message metadata: ${path}`);
		values[line.slice(0, separator)] = JSON.parse(line.slice(separator + 2));
	}
	const metadata = values as unknown as TeamMessageMetadata;
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

function filterAndLimit(messages: TeamMessage[], options: ReadMessageOptions): TeamMessage[] {
	const normalized = normalizeReadOptions(options);
	return messages
		.filter((message) => normalized.since === undefined || Date.parse(message.metadata.created_at) > normalized.since)
		.sort((a, b) => a.metadata.created_at.localeCompare(b.metadata.created_at) || a.metadata.id.localeCompare(b.metadata.id))
		.slice(-normalized.limit);
}

export class TeamStore {
	readonly root: string;

	constructor(root: string) {
		this.root = resolve(root);
	}

	async withDeliveryLock<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
		requireUuid(agentId, "agent_id");
		return withRegistryLock(join(this.root, "locks", "deliveries", agentId), operation);
	}

	private agentPath(agentId: string): string {
		requireUuid(agentId, "agent_id");
		return join(this.root, "agents", `${agentId}.json`);
	}

	private archivedAgentPath(agentId: string): string {
		requireUuid(agentId, "agent_id");
		return join(this.root, "agents", "archived", `${agentId}.json`);
	}

	async register(input: RegistrationInput, existingAgentId?: string): Promise<AgentRegistration> {
		const duties = requireText(input.duties, "duties", 20_000);
		const name = requireText(input.name ?? (basename(input.cwd) || "agent"), "name", 80);
		if (!input.sessionId.trim()) throw new Error("session ID must not be empty");
		if (existingAgentId) {
			requireUuid(existingAgentId, "agent_id");
			const path = this.agentPath(existingAgentId);
			return withRegistryLock(path, async () => {
				const existing = await readJson<AgentRegistration>(path);
				if (existing.status === "deleted") throw new Error("deleted agents cannot be reactivated");
				const now = new Date().toISOString();
				const responsibilitiesChanged = duties !== existing.duties;
				const registration: AgentRegistration = {
					...existing,
					instance_id: randomUUID(),
					name,
					duties,
					session_id: input.sessionId,
					cwd: input.cwd,
					pid: input.pid,
					status: "active",
					transport: input.transport,
					last_seen_at: now,
					responsibilities_revision: (existing.responsibilities_revision ?? 1) + (responsibilitiesChanged ? 1 : 0),
					responsibilities_updated_at: responsibilitiesChanged
						? now
						: (existing.responsibilities_updated_at ?? existing.registered_at),
				};
				delete registration.inactivated_at;
				delete registration.deleted_at;
				await writeJsonAtomic(path, registration);
				return registration;
			});
		}

		const agentId = randomUUID();
		const now = new Date().toISOString();
		const registration: AgentRegistration = {
			agent_id: agentId,
			instance_id: randomUUID(),
			name,
			duties,
			session_id: input.sessionId,
			cwd: input.cwd,
			pid: input.pid,
			status: "active",
			transport: input.transport,
			registered_at: now,
			last_seen_at: now,
			responsibilities_revision: 1,
			responsibilities_updated_at: now,
		};
		await writeJsonAtomic(this.agentPath(agentId), registration);
		return registration;
	}

	async getAgent(agentId: string): Promise<AgentRegistration> {
		return readJson<AgentRegistration>(this.agentPath(agentId));
	}

	async getArchivedAgent(agentId: string): Promise<AgentRegistration> {
		return readJson<AgentRegistration>(this.archivedAgentPath(agentId));
	}

	async listAgents(includeInactive = false, includeArchived = false): Promise<AgentRegistration[]> {
		const directories = [join(this.root, "agents")];
		if (includeArchived) directories.push(join(this.root, "agents", "archived"));
		const agents: AgentRegistration[] = [];
		for (const directory of directories) {
			if (!(await exists(directory))) continue;
			for (const entry of await readdir(directory, { withFileTypes: true })) {
				if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
				const agent = await readJson<AgentRegistration>(join(directory, entry.name));
				if (includeInactive || agent.status === "active" || (includeArchived && agent.status === "deleted")) {
					agents.push(agent);
				}
			}
		}
		return agents.sort((a, b) => a.name.localeCompare(b.name) || a.agent_id.localeCompare(b.agent_id));
	}

	async deactivate(agentId: string, instanceId: string): Promise<boolean> {
		requireUuid(instanceId, "instance_id");
		const path = this.agentPath(agentId);
		if (!(await exists(path))) return false;
		return withRegistryLock(path, async () => {
			const current = await readJson<AgentRegistration>(path);
			if (current.status !== "active" || current.instance_id !== instanceId) return false;
			const now = new Date().toISOString();
			const updated: AgentRegistration = {
				...current,
				status: "inactive",
				transport: { type: "none" },
				last_seen_at: now,
				inactivated_at: now,
			};
			await writeJsonAtomic(path, updated);
			return true;
		});
	}

	async updateResponsibilities(agentId: string, duties: string): Promise<AgentRegistration> {
		const normalizedDuties = requireText(duties, "responsibilities", 20_000);
		const path = this.agentPath(agentId);
		return withRegistryLock(path, async () => {
			const current = await readJson<AgentRegistration>(path);
			const now = new Date().toISOString();
			const updated: AgentRegistration = {
				...current,
				duties: normalizedDuties,
				responsibilities_revision: (current.responsibilities_revision ?? 0) + 1,
				responsibilities_updated_at: now,
			};
			await writeJsonAtomic(path, updated);
			return updated;
		});
	}

	async deleteAgent(agentId: string, confirmActiveDeletion = false): Promise<AgentRegistration> {
		const path = this.agentPath(agentId);
		if (!(await exists(path))) return this.getArchivedAgent(agentId);
		return withRegistryLock(path, async () => {
			const current = await readJson<AgentRegistration>(path);
			if (current.status === "active" && !confirmActiveDeletion) {
				throw new Error("deleting an active agent requires confirm=true");
			}
			const now = new Date().toISOString();
			const deleted: AgentRegistration = {
				...current,
				status: "deleted",
				transport: { type: "none" },
				last_seen_at: now,
				deleted_at: now,
			};
			await writeJsonAtomic(this.archivedAgentPath(agentId), deleted);
			await unlink(path);
			return deleted;
		});
	}

	private async writeMessage(input: WriteMessageInput, metadata: TeamMessageMetadata, path: string): Promise<TeamMessage> {
		requireText(input.body, "message", 100_000);
		await writeAtomic(path, messageMarkdown(metadata, input.body));
		return { metadata, body: `${input.body}\n`, path, read_at: null };
	}

	async sendDirect(input: WriteMessageInput & { to: string }): Promise<TeamMessage> {
		requireUuid(input.from, "from");
		requireUuid(input.to, "to");
		if (input.channel !== undefined) throw new Error("direct messages cannot specify a channel");
		if (input.delivery !== undefined && input.delivery !== "inline" && input.delivery !== "reference") {
			throw new Error("delivery must be inline or reference");
		}
		const metadata: TeamMessageMetadata = {
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

	async postChannel(input: WriteMessageInput & { channel: string }): Promise<TeamMessage> {
		requireUuid(input.from, "from");
		const channel = requireChannel(input.channel);
		if (input.to !== undefined) throw new Error("channel messages cannot specify a recipient");
		const now = new Date();
		const metadata: TeamMessageMetadata = {
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

	private async readMessage(path: string): Promise<TeamMessage> {
		const receiptPath = `${path}.read.json`;
		const readAt = (await exists(receiptPath))
			? (await readJson<ReadReceipt>(receiptPath)).read_at
			: null;
		return parseMessage(path, await readFile(path, "utf8"), readAt);
	}

	async readInbox(agentId: string, options: ReadMessageOptions = {}): Promise<TeamMessage[]> {
		requireUuid(agentId, "agent_id");
		const directory = join(this.root, "inboxes", agentId);
		if (options.messageId) {
			requireUuid(options.messageId, "message_id");
			const message = await this.readMessage(join(directory, `${options.messageId}.md`));
			return [message];
		}
		if (!(await exists(directory))) return [];
		const messages: TeamMessage[] = [];
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if (entry.isFile() && entry.name.endsWith(".md")) {
				messages.push(await this.readMessage(join(directory, entry.name)));
			}
		}
		return filterAndLimit(messages, options);
	}

	async readChannel(channel: string, options: ReadMessageOptions = {}): Promise<TeamMessage[]> {
		const directory = join(this.root, "comm_channels", requireChannel(channel));
		if (!(await exists(directory))) return [];
		const messages: TeamMessage[] = [];
		for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
			messages.push(await this.readMessage(join(entry.parentPath, entry.name)));
		}
		return filterAndLimit(messages, options);
	}

	async markRead(agentId: string, messageId: string): Promise<ReadReceipt> {
		requireUuid(messageId, "message_id");
		const [message] = await this.readInbox(agentId, { messageId });
		if (!message || message.metadata.to !== agentId) throw new Error("message is not in this agent's inbox");
		const receiptPath = `${message.path}.read.json`;
		if (await exists(receiptPath)) return readJson<ReadReceipt>(receiptPath);
		const receipt: ReadReceipt = { message_id: messageId, agent_id: agentId, read_at: new Date().toISOString() };
		await writeJsonAtomic(receiptPath, receipt);
		return receipt;
	}

	async getMessageStatus(requesterId: string, messageId: string) {
		requireUuid(requesterId, "requester_id");
		requireUuid(messageId, "message_id");
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
