import { watch, type FSWatcher } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";

import type { MessageStore } from "./store.ts";
import type { Message } from "./types.ts";

export type NativeMessageSender = (prompt: string, message: Message) => void | Promise<void>;

export interface SenderIdentity {
	name: string;
}

/**
 * Presentation hooks: consumers decide who a message is from and how a
 * wake-up prompt is rendered. Keeping these out of the watcher is what makes
 * the delivery machinery reusable across packages with different identity
 * models and prompt formats.
 */
export interface DeliveryHooks<Sender extends SenderIdentity = SenderIdentity> {
	resolveSender(message: Message): Promise<Sender>;
	formatInline(sender: Sender, message: Message): string;
	formatReference(sender: Sender, message: Message): string;
}

/**
 * Delivers durable inbox messages through a native messaging API (e.g. Pi's
 * pi.sendUserMessage). Never writes to the terminal or an editable prompt
 * buffer; that property belongs to the sender, which the caller supplies.
 */
export class InboxDelivery<Sender extends SenderIdentity = SenderIdentity> {
	private watcher: FSWatcher | undefined;
	private recipient: string | undefined;
	private generation = 0;
	private readonly delivered = new Set<string>();
	private queue: Promise<void> = Promise.resolve();
	private readonly store: Pick<MessageStore, "root" | "readInbox">;
	private readonly hooks: DeliveryHooks<Sender>;
	private readonly sendPrompt: NativeMessageSender;
	private readonly onError: (error: Error) => void;

	constructor(
		store: Pick<MessageStore, "root" | "readInbox">,
		hooks: DeliveryHooks<Sender>,
		sendPrompt: NativeMessageSender,
		onError: (error: Error) => void = () => undefined,
	) {
		this.store = store;
		this.hooks = hooks;
		this.sendPrompt = sendPrompt;
		this.onError = onError;
	}

	async start(recipient: string): Promise<void> {
		await this.stop();
		const generation = ++this.generation;
		this.recipient = recipient;
		const directory = join(this.store.root, "inboxes", recipient);
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
		this.recipient = undefined;
		this.delivered.clear();
		await this.queue;
	}

	async flush(): Promise<void> {
		await this.queue;
	}

	enqueue(messageId: string, generation = this.generation): void {
		if (!this.recipient || generation !== this.generation || this.delivered.has(messageId)) return;
		this.delivered.add(messageId);
		this.queue = this.queue.then(() => this.deliver(messageId, generation)).catch((error: Error) => {
			this.delivered.delete(messageId);
			this.onError(error);
		});
	}

	private async scan(generation: number): Promise<void> {
		const recipient = this.recipient;
		if (!recipient || generation !== this.generation) return;
		const messages = await this.store.readInbox(recipient, { limit: 200 });
		for (const message of messages) {
			if (message.read_at === null) this.enqueue(message.metadata.id, generation);
		}
	}

	private async deliver(messageId: string, generation: number): Promise<void> {
		const recipient = this.recipient;
		if (!recipient || generation !== this.generation) return;
		const [message] = await this.store.readInbox(recipient, { messageId });
		if (!message || message.read_at !== null || generation !== this.generation) return;
		const sender = await this.hooks.resolveSender(message);
		if (generation !== this.generation) return;
		const delivery = message.metadata.delivery ?? "inline";
		const prompt = delivery === "inline"
			? this.hooks.formatInline(sender, message)
			: this.hooks.formatReference(sender, message);
		await this.sendPrompt(prompt, message);
	}
}
