import { InboxDelivery as CoreInboxDelivery } from "pi-durable-inbox";

import { formatInlineMessage } from "./message-format.ts";
import type { TeamStore } from "./store.ts";
import type { AgentRegistration, TeamMessage } from "./types.ts";

export type NativeMessageSender = (
	prompt: string,
	message: TeamMessage,
	sender: AgentRegistration,
) => void | Promise<void>;

function teamHooks(store: TeamStore) {
	return {
		async resolveSender(message: TeamMessage): Promise<AgentRegistration> {
			try {
				return await store.getAgent(message.metadata.from);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				return await store.getArchivedAgent(message.metadata.from);
			}
		},
		formatInline(sender: AgentRegistration, message: TeamMessage): string {
			return formatInlineMessage(sender.name, sender.agent_id, message.metadata.id, message.body.trimEnd());
		},
		formatReference(sender: AgentRegistration, message: TeamMessage): string {
			return [
				`Team message ${message.metadata.id} from ${sender.name} is waiting in your inbox.`,
				"Use team_read_messages with message_id to read it.",
			].join(" ");
		},
	};
}

/**
 * Team-flavored durable inbox delivery: resolves sender names from the team
 * registry (archived agents included) and renders team-style prompts.
 * Delivery mechanics live in pi-durable-inbox and are shared with other
 * consumers; this class only supplies the team identity and formatting.
 */
export class InboxDelivery extends CoreInboxDelivery<AgentRegistration> {
	constructor(store: TeamStore, sendPrompt: NativeMessageSender, onError?: (error: Error) => void) {
		super(store, teamHooks(store), sendPrompt, onError);
	}
}
