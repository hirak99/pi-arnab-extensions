import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import teamExtension from "../src/index.ts";
import { TeamStore } from "../src/store.ts";

test("team_reply routes direct replies with threading, validation, and delivery choices", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-team-reply-"));
	const store = new TeamStore(root);
	const input = {
		duties: "Test agent",
		sessionId: "reply-test",
		cwd: root,
		pid: process.pid,
		transport: { type: "none" as const },
	};
	const sender = await store.register({ ...input, name: "Original sender" });
	const recipient = await store.register({ ...input, name: "Original recipient" });
	const other = await store.register({ ...input, name: "Other agent" });
	const tools = new Map<string, any>();
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<unknown>>();
	const ctx = {
		cwd: root,
		hasUI: false,
		sessionManager: {
			getSessionId: () => "reply-test",
			getBranch: () => [{
				type: "custom",
				customType: "pi-agentic-team-registration",
				data: { agent_id: recipient.agent_id },
			}],
		},
	} as unknown as ExtensionContext;
	const pi = {
		registerMessageRenderer() {},
		registerCommand() {},
		registerTool(spec: any) { tools.set(spec.name, spec); },
		appendEntry() {},
		sendMessage() {},
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown>) {
			handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI;
	const emit = async (event: string) => {
		const handler = handlers.get(event);
		assert.ok(handler, `missing ${event} handler`);
		await handler({}, ctx);
	};
	const previousRoot = process.env.PI_TEAM_DIR;
	process.env.PI_TEAM_DIR = root;
	teamExtension(pi);
	await emit("session_start");
	t.after(async () => {
		await emit("session_shutdown");
		if (previousRoot === undefined) delete process.env.PI_TEAM_DIR;
		else process.env.PI_TEAM_DIR = previousRoot;
		await rm(root, { recursive: true, force: true });
	});

	const original = await store.sendDirect({
		from: sender.agent_id,
		to: recipient.agent_id,
		body: "Original direct message",
	});
	const replyTool = tools.get("team_reply");
	assert.ok(replyTool);
	assert.ok(replyTool.promptGuidelines.some((line: string) => line.includes("normal assistant response is not delivered")));
	assert.ok(tools.get("team_reply").promptGuidelines.some((line: string) => line.includes("Receipt alone does not require")));
	assert.ok(tools.get("team_send_message").promptGuidelines.some((line: string) => line.includes("use team_reply")));

	const inline = await replyTool.execute("call-1", {
		reply_to: original.metadata.id,
		text: "Inline reply",
	});
	assert.equal(inline.details.to, sender.agent_id);
	assert.equal(inline.details.reply_to, original.metadata.id);
	const [inlineMessage] = await store.readInbox(sender.agent_id, { messageId: inline.details.message_id });
	assert.equal(inlineMessage?.metadata.from, recipient.agent_id);
	assert.equal(inlineMessage?.metadata.to, sender.agent_id);
	assert.equal(inlineMessage?.metadata.reply_to, original.metadata.id);
	assert.equal(inlineMessage?.metadata.delivery, "inline");
	assert.equal(inlineMessage?.body.trim(), "Inline reply");

	const reference = await replyTool.execute("call-2", {
		reply_to: original.metadata.id,
		text: "Reference reply",
		delivery: "reference",
	});
	const [referenceMessage] = await store.readInbox(sender.agent_id, { messageId: reference.details.message_id });
	assert.equal(referenceMessage?.metadata.delivery, "reference");
	assert.equal(referenceMessage?.metadata.reply_to, original.metadata.id);
	assert.equal(referenceMessage?.body.trim(), "Reference reply");

	const replies = (await store.readInbox(sender.agent_id))
		.filter((message) => message.metadata.from === recipient.agent_id);
	assert.equal(replies.length, 2, "replying must not generate automatic acknowledgments");

	await assert.rejects(
		() => replyTool.execute("call-3", { reply_to: "not-a-message-id", text: "Invalid" }),
		/reply_to must identify a direct message addressed to this agent/,
	);
	await assert.rejects(
		() => replyTool.execute("call-4", { reply_to: randomUUID(), text: "Unknown" }),
		/reply_to must identify a direct message addressed to this agent/,
	);
	const notAddressedToSelf = await store.sendDirect({
		from: other.agent_id,
		to: sender.agent_id,
		body: "Another agent's message",
	});
	await assert.rejects(
		() => replyTool.execute("call-4", { reply_to: notAddressedToSelf.metadata.id, text: "Invalid" }),
		/reply_to must identify a direct message addressed to this agent/,
	);
	const channelMessage = await store.postChannel({
		from: sender.agent_id,
		channel: "engineering",
		body: "Channel message",
	});
	await assert.rejects(
		() => replyTool.execute("call-5", { reply_to: channelMessage.metadata.id, text: "Invalid" }),
		/reply_to must identify a direct message addressed to this agent/,
	);
});
