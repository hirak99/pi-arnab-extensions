export type MessageDelivery = "inline" | "reference";

export interface MessageMetadata {
	id: string;
	from: string;
	to: string | null;
	/** Legacy protocol discriminator; new direct messages always write null. */
	channel: string | null;
	created_at: string;
	reply_to: string | null;
	delivery?: MessageDelivery;
	/** Optional shared ID when this direct message is part of a broadcast. */
	broadcast_id?: string;
	/** Selected audience teams; an empty array means all agents. */
	teams?: string[];
}

export interface Message {
	metadata: MessageMetadata;
	body: string;
	path: string;
	read_at: string | null;
}

export interface ReadReceipt {
	message_id: string;
	agent_id: string;
	read_at: string;
}

export interface WriteMessageInput {
	from: string;
	to?: string | undefined;
	body: string;
	replyTo?: string | undefined;
	delivery?: MessageDelivery | undefined;
	broadcastId?: string | undefined;
	teams?: string[] | undefined;
}

export interface ReadMessageOptions {
	messageId?: string | undefined;
	since?: string | undefined;
	limit?: number | undefined;
}
