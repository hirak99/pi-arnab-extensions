import { randomUUID } from "node:crypto";
import { readdir, rename, stat, unlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import {
	MessageStore,
	readJson,
	withLock,
	writeJsonAtomic,
} from "pi-durable-inbox";

import type {
	AgentRegistration,
	ReadMessageOptions,
	ReadReceipt,
	RegistrationInput,
	TeamMessage,
	WriteMessageInput,
} from "./types.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireUuid(value: string, label: string): void {
	if (!UUID_PATTERN.test(value)) throw new Error(`${label} must be a UUID`);
}

function requireText(value: string, label: string, maximum: number): string {
	const normalized = value.trim();
	if (!normalized) throw new Error(`${label} must not be empty`);
	if (value.length > maximum) throw new Error(`${label} exceeds ${maximum} characters`);
	return normalized;
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

export class TeamStore {
	readonly root: string;
	private readonly messages: MessageStore;

	constructor(root: string) {
		this.root = resolve(root);
		this.messages = new MessageStore(root);
	}

	async withDeliveryLock<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
		requireUuid(agentId, "agent_id");
		return this.messages.withDeliveryLock(agentId, operation);
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
			return withLock(path, async () => {
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
					pid: process.pid,
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
			pid: process.pid,
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
		return withLock(path, async () => {
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
		return withLock(path, async () => {
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
		return withLock(path, async () => {
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

	async sendDirect(input: WriteMessageInput & { to: string }): Promise<TeamMessage> {
		requireUuid(input.from, "from");
		requireUuid(input.to, "to");
		return this.messages.sendDirect(input);
	}

	async postChannel(input: WriteMessageInput & { channel: string }): Promise<TeamMessage> {
		requireUuid(input.from, "from");
		return this.messages.postChannel(input);
	}

	async readInbox(agentId: string, options: ReadMessageOptions = {}): Promise<TeamMessage[]> {
		requireUuid(agentId, "agent_id");
		if (options.messageId) requireUuid(options.messageId, "message_id");
		return this.messages.readInbox(agentId, options);
	}

	async readChannel(channel: string, options: ReadMessageOptions = {}): Promise<TeamMessage[]> {
		return this.messages.readChannel(channel, options);
	}

	async markRead(agentId: string, messageId: string): Promise<ReadReceipt> {
		requireUuid(agentId, "agent_id");
		requireUuid(messageId, "message_id");
		return this.messages.markRead(agentId, messageId);
	}

	async getMessageStatus(requesterId: string, messageId: string) {
		requireUuid(requesterId, "requester_id");
		requireUuid(messageId, "message_id");
		return this.messages.getMessageStatus(requesterId, messageId);
	}
}
