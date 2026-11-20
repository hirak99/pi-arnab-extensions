export type AgentStatus = "active" | "inactive" | "deleted";

export type TeamTransport =
	| { type: "tmux"; pane: string; socket?: string }
	| { type: "none" };

export interface AgentRegistration {
	agent_id: string;
	instance_id: string;
	name: string;
	duties: string;
	session_id: string;
	cwd: string;
	pid: number;
	status: AgentStatus;
	transport: TeamTransport;
	registered_at: string;
	last_seen_at: string;
	responsibilities_revision: number;
	responsibilities_updated_at: string;
	inactivated_at?: string;
	deleted_at?: string;
}

export interface RegistrationInput {
	duties: string;
	name?: string | undefined;
	sessionId: string;
	cwd: string;
	pid: number;
	transport: TeamTransport;
}

export type MessageDelivery = "inline" | "reference";

export interface TeamMessageMetadata {
	id: string;
	from: string;
	to: string | null;
	channel: string | null;
	created_at: string;
	reply_to: string | null;
	delivery?: MessageDelivery;
}

export interface TeamMessage {
	metadata: TeamMessageMetadata;
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

export interface StoredSessionIdentity {
	agent_id: string;
}
