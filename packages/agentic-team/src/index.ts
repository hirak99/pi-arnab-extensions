import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { sendNativeNotification } from "pi-durable-inbox";

import { TEAM_COMMANDS } from "./commands.ts";
import { InboxDelivery } from "./inbox-delivery.ts";
import { isTeamMessageId, parseInlineMessageId } from "./message-format.ts";
import { normalizeTeamNames, TeamStore } from "./store.ts";
import { detectTmuxTransport, tmuxPaneExists } from "./tmux.ts";
import type { AgentRegistration, RegistrationInput, TeamMessage } from "./types.ts";

const REGISTRATION_ENTRY = "pi-agentic-team-registration";
const TEAM_NOTIFICATION_TYPE = "team-message-notification";

interface TeamNotificationDetails {
	senderName: string;
	messageId?: string;
	delivery?: "inline" | "reference";
}

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
		created_at: message.metadata.created_at,
		reply_to: message.metadata.reply_to,
		broadcast_id: message.metadata.broadcast_id ?? null,
		teams: message.metadata.teams ?? [],
		read_at: message.read_at,
		body: message.body,
	};
}

export default function teamExtension(pi: ExtensionAPI) {
	const store = new TeamStore(process.env.PI_TEAM_DIR ?? join(homedir(), ".pi", "agentic-team"));
	let selfAgentId: string | undefined;
	let selfInstanceId: string | undefined;
	let inboxDelivery: InboxDelivery | undefined;

	pi.registerMessageRenderer<TeamNotificationDetails>(TEAM_NOTIFICATION_TYPE, (message, _options, theme) => {
		const details = message.details;
		const sender = details?.senderName ?? "Team message";
		const id = details?.messageId ? ` ${theme.fg("dim", `(${details.messageId})`)}` : "";
		return new Text(`${theme.fg("accent", "[team]")} ${theme.fg("accent", sender)}${id}`, 0, 0);
	});

	async function startInboxDelivery(ctx: ExtensionContext): Promise<void> {
		const agentId = requireSelf();
		inboxDelivery = new InboxDelivery(
			store,
			(prompt, message, sender) => {
				sendNativeNotification(pi, {
					customType: TEAM_NOTIFICATION_TYPE,
					content: prompt,
					details: {
						senderName: sender.name,
						messageId: message.metadata.id,
						delivery: message.metadata.delivery ?? "inline",
					},
				});
			},
			(error) => {
				if (ctx.hasUI) ctx.ui.notify(`Team inbox delivery error: ${error.message}`, "error");
			},
		);
		await inboxDelivery.start(agentId);
	}

	function registrationInput(ctx: ExtensionContext, duties: string, name?: string, teams?: string[]): RegistrationInput {
		return {
			duties,
			...(teams !== undefined ? { teams } : {}),
			name,
			sessionId: ctx.sessionManager.getSessionId(),
			cwd: ctx.cwd,
			pid: process.pid,
			transport: detectTmuxTransport(),
		};
	}

	async function registerCurrent(ctx: ExtensionContext, duties: string, name?: string, teams?: string[]): Promise<AgentRegistration> {
		const registration = await store.register(registrationInput(ctx, duties, name, teams), selfAgentId);
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

	async function sendDirectMessage(
		to: string,
		text: string,
		replyTo?: string,
		delivery: "inline" | "reference" = "inline",
	): Promise<TeamMessage> {
		const sender = await store.getAgent(requireSelf());
		const recipient = await store.getAgent(to);
		if (recipient.status !== "active" || !(await isLive(recipient))) {
			throw new Error("recipient is not active and live; message was not sent");
		}
		return store.sendDirect({
			from: sender.agent_id,
			to: recipient.agent_id,
			body: text,
			replyTo,
			delivery,
		});
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

	function agentSummary(registration: Awaited<ReturnType<typeof withLiveness>>) {
		return {
			agent_id: registration.agent_id,
			name: registration.name,
			duties: registration.duties,
			teams: registration.teams ?? [],
			status: registration.status,
			live: registration.live,
			effective_status: registration.effective_status,
			is_self: registration.is_self,
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

	async function recordReceipt(messageId: string | undefined): Promise<void> {
		if (!selfAgentId || !messageId) return;
		try {
			await store.markRead(selfAgentId, messageId);
		} catch {
			// A receipt failure must never block delivery of the actual message.
		}
	}

	pi.on("input", async (event) => {
		await recordReceipt(parseInlineMessageId(event.text) ?? undefined);
	});

	pi.on("message_end", async (event) => {
		if (event.message.role !== "custom" || event.message.customType !== TEAM_NOTIFICATION_TYPE) return;
		const details = event.message.details as TeamNotificationDetails | undefined;
		if (details?.delivery === "reference") return;
		await recordReceipt(typeof details?.messageId === "string" ? details.messageId : undefined);
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
			sendNativeNotification(pi, {
				customType: TEAM_NOTIFICATION_TYPE,
				content: notification,
				details: { senderName: "Team responsibilities" },
			});
		},
	});

	pi.registerTool({
		name: "team_register",
		label: "Register team agent",
		description: "Register this Pi session as a team agent when the human asks. Duties describe its role. Optional teams are a full replacement membership list; omit teams to remain unassigned or preserve existing memberships.",
		promptSnippet: "Register this session as a team agent",
		promptGuidelines: ["Use team_register only when the human asks this session to join an agent team."],
		executionMode: "sequential",
		parameters: Type.Object({
			duties: Type.String({ description: "This agent's responsibilities" }),
			teams: Type.Optional(Type.Array(Type.String({ description: "Team slug: lowercase letters, digits, underscores, and hyphens" }), {
				description: "Optional full membership list; omit to stay unassigned or preserve memberships, use [] to clear memberships",
			})),
			name: Type.Optional(Type.String({ description: "Optional human-friendly agent name" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const registration = await registerCurrent(ctx, params.duties, params.name, params.teams);
			return toolResult({ agent_id: registration.agent_id });
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
			const registration = await withLiveness(await store.getAgent(requireSelf()));
			return toolResult({
				...agentSummary(registration),
				instance_id: registration.instance_id,
				responsibilities_revision: registration.responsibilities_revision,
			});
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
				agents: (await Promise.all(agents.map(withLiveness))).map(agentSummary),
			});
		},
	});

	pi.registerTool({
		name: "team_delete_member",
		label: "Delete team member",
		description: "Archive a team registration without deleting inbox messages. Active deletion requires confirm=true.",
		executionMode: "sequential",
		parameters: Type.Object({
			agent_id: Type.String({ description: "Persistent team agent UUID" }),
			confirm: Type.Optional(Type.Boolean({ description: "Required when deleting an active member" })),
		}),
		async execute(_toolCallId, params) {
			await store.deleteAgent(params.agent_id, params.confirm ?? false);
			if (selfAgentId === params.agent_id) {
				await inboxDelivery?.stop();
				inboxDelivery = undefined;
				selfAgentId = undefined;
				selfInstanceId = undefined;
				pi.appendEntry(REGISTRATION_ENTRY, { agent_id: null });
			}
			return {
				content: [{ type: "text" as const, text: "Team member deleted. Inbox preserved." }],
				details: { deleted: true, inbox_preserved: true },
			};
		},
	});

	pi.registerTool({
		name: "team_send_message",
		label: "Send team message",
		description: "Persist a direct message for another active team agent and deliver a custom notification that steers a busy session or starts an idle follow-up turn without entering terminal input. Defaults to inline delivery; use reference delivery for sensitive content.",
		promptSnippet: "Send a durable direct message to another team agent",
		promptGuidelines: [
			"When a response to a direct team message is requested or useful, use team_reply with reply_to instead of addressing a new message manually.",
			"A normal assistant response is not delivered to the originating agent. Receipt alone does not require an acknowledgment.",
		],
		parameters: Type.Object({
			to: Type.String({ description: "Recipient team agent UUID" }),
			text: Type.String({ description: "Message body" }),
			reply_to: Type.Optional(Type.String({ description: "Optional message UUID being replied to" })),
			delivery: Type.Optional(Type.Union([Type.Literal("inline"), Type.Literal("reference")], {
				description: "inline includes the body in the wake-up; reference sends only metadata and requires an inbox read (default inline)",
			})),
		}),
		async execute(_toolCallId, params, _signal) {
			const message = await sendDirectMessage(params.to, params.text, params.reply_to, params.delivery ?? "inline");
			return toolResult({ message_id: message.metadata.id, persisted: true, wake_status: "queued" });
		},
	});

	pi.registerTool({
		name: "team_broadcast",
		label: "Broadcast to team agents",
		description: "Persist one direct inbox message per selected active agent and deliver native busy/idle notifications. Omit teams to include every active agent, including unassigned agents; otherwise target the union of team members. Sender is excluded, duplicate recipients are deduplicated, and inactive agents are skipped. Supports inline or reference delivery.",
		promptSnippet: "Broadcast a durable message to selected teams or all active agents",
		promptGuidelines: [
			"Use team_broadcast only for an intentional group notification. Replies should use team_reply to the sender, never an automatic rebroadcast.",
			"Receipt alone does not require an acknowledgment; do not generate automatic acknowledgments or broadcast-reply storms.",
		],
		executionMode: "sequential",
		parameters: Type.Object({
			teams: Type.Optional(Type.Array(Type.String({ description: "Team slug" }), {
				description: "Optional list of target teams; omit for all active agents. An explicit empty list is invalid.",
			})),
			text: Type.String({ description: "Broadcast body" }),
			delivery: Type.Optional(Type.Union([Type.Literal("inline"), Type.Literal("reference")], {
				description: "inline includes the body in each wake-up; reference sends only metadata and requires inbox reads (default inline)",
			})),
		}),
		async execute(_toolCallId, params) {
			const self = requireSelf();
			if (!params.text.trim()) throw new Error("message must not be empty");
			if (params.text.length > 100_000) throw new Error("message exceeds 100000 characters");
			const selectedTeams = params.teams === undefined ? undefined : normalizeTeamNames(params.teams);
			if (selectedTeams?.length === 0) throw new Error("teams must be omitted for an all-agent broadcast or contain at least one team");
			const candidates = (await store.listAgents(true, false)).filter((agent) => {
				if (agent.agent_id === self) return false;
				if (selectedTeams === undefined) return true;
				return (agent.teams ?? []).some((team) => selectedTeams.includes(team));
			});
			const recipients: AgentRegistration[] = [];
			const inactiveAgentIds: string[] = [];
			for (const agent of candidates) {
				if (agent.status === "active" && await isLive(agent)) recipients.push(agent);
				else inactiveAgentIds.push(agent.agent_id);
			}
			const broadcastId = randomUUID();
			const deliveries: Array<{ agent_id: string; message_id: string }> = [];
			const failedAgentIds: string[] = [];
			for (const recipient of recipients) {
				try {
					const message = await store.sendDirect({
						from: self,
						to: recipient.agent_id,
						body: params.text,
						broadcastId,
						teams: selectedTeams ?? [],
						delivery: params.delivery ?? "inline",
					});
					deliveries.push({ agent_id: recipient.agent_id, message_id: message.metadata.id });
				} catch {
					failedAgentIds.push(recipient.agent_id);
				}
			}
			return toolResult({
				broadcast_id: broadcastId,
				teams: selectedTeams ?? [],
				recipient_count: deliveries.length,
				inactive_count: inactiveAgentIds.length,
				failed_count: failedAgentIds.length,
				deliveries,
				...(failedAgentIds.length ? { failed_agent_ids: failedAgentIds } : {}),
				persisted: deliveries.length > 0,
				wake_status: deliveries.length > 0 ? "queued" : "no_recipients",
			});
		},
	});

	pi.registerTool({
		name: "team_reply",
		label: "Reply to team message",
		description: "Reply to a direct team message addressed to this agent, including a broadcast delivery. Resolves the original sender automatically and preserves reply threading; unknown and other agents' messages are rejected. Supports inline or reference delivery.",
		promptSnippet: "Reply to a direct team message with automatic recipient and threading",
		promptGuidelines: [
			"When a response to a direct team message is requested or useful, use team_reply with reply_to. A normal assistant response is not delivered to the originating agent.",
			"Receipt alone does not require an acknowledgment. Watch notifications are not direct-reply requests.",
		],
		parameters: Type.Object({
			reply_to: Type.String({ description: "Direct message UUID addressed to this agent" }),
			text: Type.String({ description: "Reply body" }),
			delivery: Type.Optional(Type.Union([Type.Literal("inline"), Type.Literal("reference")], {
				description: "inline includes the reply body in the wake-up; reference sends only metadata and requires an inbox read (default inline)",
			})),
		}),
		async execute(_toolCallId, params) {
			const self = requireSelf();
			if (!isTeamMessageId(params.reply_to)) {
				throw new Error("reply_to must identify a direct message addressed to this agent");
			}
			let original: TeamMessage | undefined;
			try {
				[original] = await store.readInbox(self, { messageId: params.reply_to });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			if (!original || original.metadata.channel !== null || original.metadata.to !== self) {
				throw new Error("reply_to must identify a direct message addressed to this agent");
			}
			const message = await sendDirectMessage(
				original.metadata.from,
				params.text,
				original.metadata.id,
				params.delivery ?? "inline",
			);
			return toolResult({
				message_id: message.metadata.id,
				to: original.metadata.from,
				reply_to: original.metadata.id,
				persisted: true,
				wake_status: "queued",
			});
		},
	});

	pi.registerTool({
		name: "team_read_messages",
		label: "Read team messages",
		description: "Read this agent's direct inbox, including broadcast deliveries. Reading messages automatically records read receipts.",
		promptSnippet: "Read direct team messages with automatic read receipts",
		parameters: Type.Object({
			message_id: Type.Optional(Type.String({ description: "Read one direct message from this agent's inbox" })),
			since: Type.Optional(Type.String({ description: "Return messages after this ISO timestamp" })),
			limit: Type.Optional(Type.Number({ description: "Maximum messages, from 1 to 200; default 50" })),
		}),
		async execute(_toolCallId, params) {
			const options = { since: params.since, limit: params.limit, messageId: params.message_id };
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
			message_id: Type.String({ description: "Direct message UUID returned by team_send_message, team_reply, or an individual team_broadcast delivery" }),
		}),
		async execute(_toolCallId, params) {
			return toolResult(await store.getMessageStatus(requireSelf(), params.message_id));
		},
	});
}
