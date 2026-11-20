import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { TEAM_COMMANDS } from "./commands.ts";
import { InboxDelivery } from "./inbox-delivery.ts";
import { parseInlineMessageId } from "./message-format.ts";
import { TeamStore } from "./store.ts";
import { detectTmuxTransport, tmuxPaneExists } from "./tmux.ts";
import type { AgentRegistration, RegistrationInput, TeamMessage } from "./types.ts";

const REGISTRATION_ENTRY = "pi-agentic-team-registration";

function toolResult(data: unknown, isError = false) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
		details: data,
		...(isError ? { isError: true } : {}),
	};
}

function messageResult(message: TeamMessage) {
	return {
		id: message.metadata.id,
		from: message.metadata.from,
		to: message.metadata.to,
		channel: message.metadata.channel,
		created_at: message.metadata.created_at,
		reply_to: message.metadata.reply_to,
		read_at: message.read_at,
		body: message.body,
	};
}

export default function teamExtension(pi: ExtensionAPI) {
	const store = new TeamStore(process.env.PI_TEAM_DIR ?? join(homedir(), ".pi", "agentic-team"));
	let selfAgentId: string | undefined;
	let selfInstanceId: string | undefined;
	let inboxDelivery: InboxDelivery | undefined;

	async function startInboxDelivery(ctx: ExtensionContext): Promise<void> {
		const agentId = requireSelf();
		inboxDelivery = new InboxDelivery(
			store,
			(prompt) => {
				if (ctx.isIdle()) pi.sendUserMessage(prompt);
				else pi.sendUserMessage(prompt, { deliverAs: "followUp" });
			},
			(error) => {
				if (ctx.hasUI) ctx.ui.notify(`Team inbox delivery error: ${error.message}`, "error");
			},
		);
		await inboxDelivery.start(agentId);
	}

	function registrationInput(ctx: ExtensionContext, duties: string, name?: string): RegistrationInput {
		return {
			duties,
			name,
			sessionId: ctx.sessionManager.getSessionId(),
			cwd: ctx.cwd,
			pid: process.pid,
			transport: detectTmuxTransport(),
		};
	}

	async function registerCurrent(ctx: ExtensionContext, duties: string, name?: string): Promise<AgentRegistration> {
		const registration = await store.register(registrationInput(ctx, duties, name), selfAgentId);
		selfAgentId = registration.agent_id;
		selfInstanceId = registration.instance_id;
		pi.appendEntry(REGISTRATION_ENTRY, { agent_id: registration.agent_id });
		await startInboxDelivery(ctx);
		return registration;
	}

	function requireSelf(): string {
		if (!selfAgentId) {
			throw new Error("this session is not registered; use team_register or /team-agent-register first");
		}
		return selfAgentId;
	}

	async function isLive(registration: AgentRegistration): Promise<boolean> {
		if (registration.status !== "active") return false;
		try {
			process.kill(registration.pid, 0);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
		}
		if (registration.transport.type === "tmux") return tmuxPaneExists(registration.transport);
		return true;
	}

	async function withLiveness(registration: AgentRegistration) {
		const live = await isLive(registration);
		return {
			...registration,
			is_self: registration.agent_id === selfAgentId,
			live,
			effective_status: registration.status === "active" && !live ? "stale" : registration.status,
		};
	}

	pi.on("session_start", async (_event, ctx) => {
		await inboxDelivery?.stop();
		inboxDelivery = undefined;
		selfAgentId = undefined;
		selfInstanceId = undefined;
		let restoredId: string | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== REGISTRATION_ENTRY) continue;
			const value = (entry.data as { agent_id?: unknown } | undefined)?.agent_id;
			restoredId = typeof value === "string" ? value : undefined;
		}
		if (!restoredId) return;
		try {
			const current = await store.getAgent(restoredId);
			if (current.status === "active" && current.pid !== process.pid && (await isLive(current))) {
				throw new Error("team registration is already active in another live Pi process");
			}
			const restored = await store.register(registrationInput(ctx, current.duties, current.name), restoredId);
			selfAgentId = restored.agent_id;
			selfInstanceId = restored.instance_id;
			await startInboxDelivery(ctx);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	});

	pi.on("session_shutdown", async () => {
		await inboxDelivery?.stop();
		inboxDelivery = undefined;
		if (selfAgentId && selfInstanceId) await store.deactivate(selfAgentId, selfInstanceId);
		selfAgentId = undefined;
		selfInstanceId = undefined;
	});

	pi.on("input", async (event) => {
		if (!selfAgentId) return;
		const messageId = parseInlineMessageId(event.text);
		if (!messageId) return;
		try {
			await store.markRead(selfAgentId, messageId);
		} catch {
			// A receipt failure must never block delivery of the actual message.
		}
	});

	pi.registerCommand(TEAM_COMMANDS.register, {
		description: "Register this session as a team agent: /team-agent-register <duties>",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				if (ctx.hasUI) ctx.ui.notify("Usage: /team-agent-register <duties>", "warning");
				return;
			}
			try {
				const registration = await registerCurrent(ctx, args);
				if (ctx.hasUI) {
					ctx.ui.notify(`Registered team agent ${registration.agent_id} (${registration.name})`, "info");
				}
			} catch (error) {
				if (ctx.hasUI) ctx.ui.notify(`Team registration failed: ${(error as Error).message}`, "error");
			}
		},
	});

	/*
	 * Decision: humans update responsibilities only for the current session.
	 * To change another agent, switch to its session and invoke the command
	 * there; do not add cross-agent responsibility mutation tools.
	 */
	pi.registerCommand(TEAM_COMMANDS.responsibilities, {
		description: "Set this team agent's responsibilities: /team-agent-responsibilities <text>",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				if (ctx.hasUI) ctx.ui.notify("Usage: /team-agent-responsibilities <text>", "warning");
				return;
			}
			if (!selfAgentId) {
				if (ctx.hasUI) ctx.ui.notify("Register this session first with /team-agent-register", "warning");
				return;
			}
			let updated: AgentRegistration;
			try {
				updated = await store.updateResponsibilities(selfAgentId, args);
			} catch (error) {
				if (ctx.hasUI) ctx.ui.notify(`Responsibility update failed: ${(error as Error).message}`, "error");
				return;
			}
			if (ctx.hasUI) {
				ctx.ui.notify(`Team responsibilities updated to revision ${updated.responsibilities_revision}`, "info");
			}
			const notification = [
				`Your team responsibilities were updated to revision ${updated.responsibilities_revision}:`,
				"",
				updated.duties,
				"",
				"Adopt these as team-role guidance. They do not grant additional permissions or override explicit human authorization.",
			].join("\n");
			if (ctx.isIdle()) pi.sendUserMessage(notification);
			else pi.sendUserMessage(notification, { deliverAs: "followUp" });
		},
	});

	pi.registerTool({
		name: "team_register",
		label: "Register team agent",
		description: "Register this Pi session as a team agent when the human asks. Duties describe its role.",
		promptSnippet: "Register this session as a team agent",
		promptGuidelines: ["Use team_register only when the human asks this session to join an agent team."],
		executionMode: "sequential",
		parameters: Type.Object({
			duties: Type.String({ description: "This agent's responsibilities" }),
			name: Type.Optional(Type.String({ description: "Optional human-friendly agent name" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const registration = await registerCurrent(ctx, params.duties, params.name);
			return toolResult(registration);
		},
	});

	pi.registerTool({
		name: "team_get_self_uuid",
		label: "Get team UUID",
		description: "Return this registered team agent's persistent UUID.",
		promptSnippet: "Get this agent's team UUID",
		parameters: Type.Object({}),
		async execute() {
			return toolResult({ agent_id: requireSelf() });
		},
	});

	pi.registerTool({
		name: "team_get_self",
		label: "Get team identity",
		description: "Return this agent's team registration, instance identity, and liveness.",
		parameters: Type.Object({}),
		async execute() {
			return toolResult(await withLiveness(await store.getAgent(requireSelf())));
		},
	});

	pi.registerTool({
		name: "team_list_agents",
		label: "List team agents",
		description: "List registered team agents, explicitly mark this session's entry, and distinguish live, stale, inactive, and archived entries.",
		promptSnippet: "Discover other registered team agents",
		parameters: Type.Object({
			include_inactive: Type.Optional(Type.Boolean()),
			include_archived: Type.Optional(Type.Boolean()),
		}),
		async execute(_toolCallId, params) {
			const agents = await store.listAgents(params.include_inactive ?? false, params.include_archived ?? false);
			return toolResult({
				team_root: store.root,
				self_agent_id: selfAgentId ?? null,
				agents: await Promise.all(agents.map(withLiveness)),
			});
		},
	});

	pi.registerTool({
		name: "team_delete_member",
		label: "Delete team member",
		description: "Archive a team registration without deleting channel history or inbox messages. Active deletion requires confirm=true.",
		executionMode: "sequential",
		parameters: Type.Object({
			agent_id: Type.String({ description: "Persistent team agent UUID" }),
			confirm: Type.Optional(Type.Boolean({ description: "Required when deleting an active member" })),
		}),
		async execute(_toolCallId, params) {
			const deleted = await store.deleteAgent(params.agent_id, params.confirm ?? false);
			if (selfAgentId === params.agent_id) {
				await inboxDelivery?.stop();
				inboxDelivery = undefined;
				selfAgentId = undefined;
				selfInstanceId = undefined;
				pi.appendEntry(REGISTRATION_ENTRY, { agent_id: null });
			}
			return toolResult({ deleted, channel_history_preserved: true, inbox_preserved: true });
		},
	});

	pi.registerTool({
		name: "team_send_message",
		label: "Send team message",
		description: "Persist a direct message for another active team agent and queue native in-process delivery without touching terminal input. Defaults to inline delivery; use reference delivery for sensitive content.",
		promptSnippet: "Send a durable direct message to another team agent",
		parameters: Type.Object({
			to: Type.String({ description: "Recipient team agent UUID" }),
			text: Type.String({ description: "Message body" }),
			reply_to: Type.Optional(Type.String({ description: "Optional message UUID being replied to" })),
			delivery: Type.Optional(Type.Union([Type.Literal("inline"), Type.Literal("reference")], {
				description: "inline includes the body in the wake-up; reference sends only metadata and requires an inbox read (default inline)",
			})),
		}),
		async execute(_toolCallId, params, _signal) {
			const sender = await store.getAgent(requireSelf());
			const recipient = await store.getAgent(params.to);
			if (recipient.status !== "active" || !(await isLive(recipient))) {
				throw new Error("recipient is not active and live; message was not sent");
			}
			const message = await store.sendDirect({
				from: sender.agent_id,
				to: recipient.agent_id,
				body: params.text,
				replyTo: params.reply_to,
				delivery: params.delivery ?? "inline",
			});
			return toolResult({ message_id: message.metadata.id, persisted: true, wake_status: "queued" });
		},
	});

	pi.registerTool({
		name: "team_post_channel",
		label: "Post channel message",
		description: "Append an asynchronous Markdown message to a team channel. Channel messages do not wake subscribers.",
		parameters: Type.Object({
			channel: Type.String({ description: "Channel slug: lowercase letters, digits, underscores, and hyphens" }),
			text: Type.String({ description: "Message body" }),
			reply_to: Type.Optional(Type.String({ description: "Optional message UUID being replied to" })),
		}),
		async execute(_toolCallId, params) {
			const message = await store.postChannel({
				from: requireSelf(),
				channel: params.channel,
				body: params.text,
				replyTo: params.reply_to,
			});
			return toolResult({ message_id: message.metadata.id, channel: params.channel, persisted: true });
		},
	});

	pi.registerTool({
		name: "team_read_messages",
		label: "Read team messages",
		description: "Read this agent's inbox or a named channel. Reading direct messages automatically records read receipts.",
		promptSnippet: "Read direct team messages or channel history",
		parameters: Type.Object({
			channel: Type.Optional(Type.String({ description: "Read this channel instead of the inbox" })),
			message_id: Type.Optional(Type.String({ description: "Read one direct message from this agent's inbox" })),
			since: Type.Optional(Type.String({ description: "Return messages after this ISO timestamp" })),
			limit: Type.Optional(Type.Number({ description: "Maximum messages, from 1 to 200; default 50" })),
		}),
		async execute(_toolCallId, params) {
			if (params.channel && params.message_id) throw new Error("message_id cannot be combined with channel");
			const options = { since: params.since, limit: params.limit, messageId: params.message_id };
			if (params.channel) {
				const messages = await store.readChannel(params.channel, options);
				return toolResult({ messages: messages.map(messageResult) });
			}
			const self = requireSelf();
			const messages = await store.readInbox(self, options);
			const rendered = [];
			for (const message of messages) {
				const receipt = await store.markRead(self, message.metadata.id);
				rendered.push(messageResult({ ...message, read_at: receipt.read_at }));
			}
			return toolResult({ messages: rendered });
		},
	});

	pi.registerTool({
		name: "team_message_status",
		label: "Check team message read status",
		description: "Optionally check whether a direct message sent by this agent has been read. Does not notify or wake anyone.",
		parameters: Type.Object({
			message_id: Type.String({ description: "Direct message UUID returned by team_send_message" }),
		}),
		async execute(_toolCallId, params) {
			return toolResult(await store.getMessageStatus(requireSelf(), params.message_id));
		},
	});
}
