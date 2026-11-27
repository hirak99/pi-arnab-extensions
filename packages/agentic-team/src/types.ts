export type {
	Message as TeamMessage,
	MessageDelivery,
	MessageMetadata as TeamMessageMetadata,
	ReadMessageOptions,
	ReadReceipt,
	WriteMessageInput,
} from "pi-durable-inbox";

export type AgentStatus = "active" | "inactive" | "deleted";

export type TeamTransport =
	| { type: "tmux"; pane: string; socket?: string }
	| { type: "none" };

export interface AgentRegistration {
	agent_id: string;
	instance_id: string;
	name: string;
	duties: string;
	/** Team slugs; absent in legacy registrations. New registrations always set an array. */
	teams?: string[];
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
	/** Full replacement membership list when supplied. */
	teams?: string[] | undefined;
	name?: string | undefined;
	sessionId: string;
	cwd: string;
	pid: number;
	transport: TeamTransport;
}

export interface StoredSessionIdentity {
	agent_id: string;
}
