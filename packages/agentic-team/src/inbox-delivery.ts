import { watch, type FSWatcher } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";

import { formatInlineMessage } from "./message-format.ts";
import type { TeamStore } from "./store.ts";
import type { TeamMessage } from "./types.ts";

export type NativeMessageSender = (prompt: string, message: TeamMessage) => void | Promise<void>;

/**
 * Delivers durable inbox messages through Pi's native messaging API.
 * Never writes to the terminal or its editable prompt buffer.
 */
export class InboxDelivery {
	private watcher: FSWatcher | undefined;
	private agentId: string | undefined;
	private generation = 0;
	private readonly delivered = new Set<string>();
	private queue: Promise<void> = Promise.resolve();
	private readonly store: TeamStore;
	private readonly sendPrompt: NativeMessageSender;
	private readonly onError: (error: Error) => void;

	constructor(
		store: TeamStore,
		sendPrompt: NativeMessageSender,
		onError: (error: Error) => void = () => undefined,
	) {
		this.store = store;
		this.sendPrompt = sendPrompt;
		this.onError = onError;
	}

	async start(agentId: string): Promise<void> {
		await this.stop();
		const generation = ++this.generation;
		this.agentId = agentId;
		const directory = join(this.store.root, "inboxes", agentId);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		this.watcher = watch(directory, { persistent: false }, (_eventType, filename) => {
			if (filename?.endsWith(".md")) this.enqueue(basename(filename, ".md"), generation);
			else void this.scan(generation).catch((error: Error) => this.onError(error));
		});
		this.watcher.on("error", (error) => this.onError(error));
		await this.scan(generation);
	}

	async stop(): Promise<void> {
		++this.generation;
		this.watcher?.close();
		this.watcher = undefined;
		this.agentId = undefined;
		this.delivered.clear();
		await this.queue;
	}

	async flush(): Promise<void> {
		await this.queue;
	}

	enqueue(messageId: string, generation = this.generation): void {
		if (!this.agentId || generation !== this.generation || this.delivered.has(messageId)) return;
		this.delivered.add(messageId);
		this.queue = this.queue.then(() => this.deliver(messageId, generation)).catch((error: Error) => {
			this.delivered.delete(messageId);
			this.onError(error);
		});
	}

	private async scan(generation: number): Promise<void> {
		const agentId = this.agentId;
		if (!agentId || generation !== this.generation) return;
		const messages = await this.store.readInbox(agentId, { limit: 200 });
		for (const message of messages) {
			if (message.read_at === null) this.enqueue(message.metadata.id, generation);
		}
	}

	private async deliver(messageId: string, generation: number): Promise<void> {
		const agentId = this.agentId;
		if (!agentId || generation !== this.generation) return;
		const [message] = await this.store.readInbox(agentId, { messageId });
		if (!message || message.read_at !== null || generation !== this.generation) return;
		let sender;
		try {
			sender = await this.store.getAgent(message.metadata.from);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			sender = await this.store.getArchivedAgent(message.metadata.from);
		}
		if (generation !== this.generation) return;
		const delivery = message.metadata.delivery ?? "inline";
		const prompt = delivery === "inline"
			? formatInlineMessage(sender.name, sender.agent_id, message.metadata.id, message.body.trimEnd())
			: [
					`Team message ${message.metadata.id} from ${sender.name} is waiting in your inbox.`,
					"Use team_read_messages with message_id to read it.",
				].join(" ");
		await this.sendPrompt(prompt, message);
	}
}
