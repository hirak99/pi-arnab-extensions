export type MessageDelivery = "inline" | "reference";

export interface MessageMetadata {
	id: string;
	from: string;
	to: string | null;
	channel: string | null;
	created_at: string;
	reply_to: string | null;
	delivery?: MessageDelivery;
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
	channel?: string | undefined;
	body: string;
	replyTo?: string | undefined;
	delivery?: MessageDelivery | undefined;
}

export interface ReadMessageOptions {
	messageId?: string | undefined;
	since?: string | undefined;
	limit?: number | undefined;
}
