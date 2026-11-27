import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import teamExtension from "../src/index.ts";
import { InboxDelivery } from "../src/inbox-delivery.ts";
import { TeamStore } from "../src/store.ts";
import type { AgentRegistration } from "../src/types.ts";

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("timed out waiting for native inbox delivery");
		await delay(10);
	}
}

async function fixture(t: test.TestContext) {
	const root = await mkdtemp(join(tmpdir(), "pi-team-delivery-"));
	const store = new TeamStore(root);
	const input = {
		duties: "Test agent",
		sessionId: "test-session",
		cwd: root,
		pid: process.pid,
		transport: { type: "none" as const },
	};
	const sender = await store.register({ ...input, name: "Sender" });
	const recipient = await store.register({ ...input, name: "Recipient" });
	t.after(() => rm(root, { recursive: true, force: true }));
	return { store, sender, recipient };
}

function registrationId(registration: AgentRegistration): string {
	return registration.agent_id;
}

test("native inbox delivery leaves an unfinished editor draft untouched", async (t) => {
	const { store, sender, recipient } = await fixture(t);
	const editor = { draft: "Please finish my unfinished draft", submitted: [] as string[] };
	const nativeMessages: string[] = [];
	const errors: Error[] = [];
	const delivery = new InboxDelivery(store, (prompt) => {
		// Models the native sender callback: no terminal writes or draft mutation.
		nativeMessages.push(prompt);
	}, (error) => errors.push(error));
	await delivery.start(registrationId(recipient));
	t.after(() => delivery.stop());

	const message = await store.sendDirect({
		from: sender.agent_id,
		to: recipient.agent_id,
		body: "TEAM MESSAGE CONTENT",
		delivery: "inline",
	});
	await waitFor(() => nativeMessages.length === 1);
	await delivery.flush();

	assert.equal(editor.draft, "Please finish my unfinished draft");
	assert.deepEqual(editor.submitted, []);
	assert.equal(nativeMessages.length, 1);
	assert.match(nativeMessages[0]!, /TEAM MESSAGE CONTENT/);
	assert.match(nativeMessages[0]!, new RegExp(message.metadata.id));
	assert.deepEqual(errors, []);
});

test("reference delivery keeps the body out of the native wake-up", async (t) => {
	const { store, sender, recipient } = await fixture(t);
	const nativeMessages: string[] = [];
	const delivery = new InboxDelivery(store, (prompt) => {
		nativeMessages.push(prompt);
	});
	await delivery.start(recipient.agent_id);
	t.after(() => delivery.stop());

	const message = await store.sendDirect({
		from: sender.agent_id,
		to: recipient.agent_id,
		body: "SENSITIVE BODY MUST NOT BE INLINED",
		delivery: "reference",
		replyTo: sender.agent_id,
	});
	await waitFor(() => nativeMessages.length === 1);
	assert.doesNotMatch(nativeMessages[0]!, /SENSITIVE BODY/);
	assert.match(nativeMessages[0]!, new RegExp(message.metadata.id));
	assert.match(nativeMessages[0]!, new RegExp(`in reply to ${sender.agent_id}`));
});

test("broadcast delivery labels the audience and preserves reference privacy", async (t) => {
	const { store, sender, recipient } = await fixture(t);
	const nativeMessages: string[] = [];
	const delivery = new InboxDelivery(store, (prompt) => {
		nativeMessages.push(prompt);
	});
	await delivery.start(recipient.agent_id);
	t.after(() => delivery.stop());

	const inline = await store.sendDirect({
		from: sender.agent_id,
		to: recipient.agent_id,
		body: "BROADCAST INLINE BODY",
		delivery: "inline",
		broadcastId: randomUUID(),
		teams: ["dev", "ops"],
	});
	await waitFor(() => nativeMessages.length === 1);
	assert.match(nativeMessages[0]!, /Team broadcast from Sender .* to dev, ops/);
	assert.match(nativeMessages[0]!, /BROADCAST INLINE BODY/);
	assert.match(nativeMessages[0]!, new RegExp(inline.metadata.id));

	await store.sendDirect({
		from: sender.agent_id,
		to: recipient.agent_id,
		body: "BROADCAST PRIVATE BODY",
		delivery: "reference",
		broadcastId: randomUUID(),
		teams: [],
	});
	await waitFor(() => nativeMessages.length === 2);
	assert.match(nativeMessages[1]!, /Team broadcast .* to all agents is waiting in your inbox/);
	assert.doesNotMatch(nativeMessages[1]!, /BROADCAST PRIVATE BODY/);
});

test("duplicate watcher events deliver a message once", async (t) => {
	const { store, sender, recipient } = await fixture(t);
	const nativeMessages: string[] = [];
	const delivery = new InboxDelivery(store, () => {
		nativeMessages.push("delivered");
	});
	await delivery.start(recipient.agent_id);
	t.after(() => delivery.stop());
	const message = await store.sendDirect({
		from: sender.agent_id,
		to: recipient.agent_id,
		body: "Once",
	});
	await waitFor(() => nativeMessages.length === 1);
	delivery.enqueue(message.metadata.id);
	delivery.enqueue(message.metadata.id);
	await delivery.flush();
	assert.equal(nativeMessages.length, 1);
});

test("startup delivers unread backlog but not messages already read", async (t) => {
	const { store, sender, recipient } = await fixture(t);
	const unread = await store.sendDirect({ from: sender.agent_id, to: recipient.agent_id, body: "Unread" });
	const read = await store.sendDirect({ from: sender.agent_id, to: recipient.agent_id, body: "Read" });
	await store.markRead(recipient.agent_id, read.metadata.id);
	const nativeMessages: string[] = [];
	const delivery = new InboxDelivery(store, (prompt) => {
		nativeMessages.push(prompt);
	});
	await delivery.start(recipient.agent_id);
	await delivery.flush();
	t.after(() => delivery.stop());
	assert.equal(nativeMessages.length, 1);
	assert.match(nativeMessages[0]!, new RegExp(unread.metadata.id));
	assert.doesNotMatch(nativeMessages[0]!, new RegExp(read.metadata.id));
});

test("native inline receipts prevent restart replay while references await inbox reads", async (t) => {
	const { store, sender, recipient } = await fixture(t);
	type Handler = (event: any, ctx: ExtensionContext) => unknown;
	const handlers = new Map<string, Handler[]>();
	const nativeMessages: Array<Record<string, unknown>> = [];
	const receiptEvents: Promise<unknown>[] = [];
	const ctx = {
		cwd: store.root,
		hasUI: false,
		sessionManager: {
			getSessionId: () => "native-restart-test",
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
		registerTool() {},
		appendEntry() {},
		on(event: string, handler: Handler) {
			const registered = handlers.get(event) ?? [];
			registered.push(handler);
			handlers.set(event, registered);
		},
		sendMessage(message: Record<string, unknown>) {
			const complete = { ...message, role: "custom" };
			nativeMessages.push(complete);
			for (const handler of handlers.get("message_end") ?? []) {
				receiptEvents.push(Promise.resolve(handler({ message: complete }, ctx)));
			}
		},
	} as unknown as ExtensionAPI;
	const emit = async (event: string) => {
		for (const handler of handlers.get(event) ?? []) await handler({}, ctx);
	};
	const previousTeamDir = process.env.PI_TEAM_DIR;
	process.env.PI_TEAM_DIR = store.root;
	t.after(() => {
		if (previousTeamDir === undefined) delete process.env.PI_TEAM_DIR;
		else process.env.PI_TEAM_DIR = previousTeamDir;
	});
	teamExtension(pi);
	await emit("session_start");
	t.after(() => emit("session_shutdown"));

	const message = await store.sendDirect({
		from: sender.agent_id,
		to: recipient.agent_id,
		body: "Deliver once",
	});
	await waitFor(() => nativeMessages.length === 1);
	await Promise.all(receiptEvents);
	const [delivered] = await store.readInbox(recipient.agent_id, { messageId: message.metadata.id });
	assert.equal(delivered?.read_at !== null, true);

	await emit("session_start");
	assert.equal(nativeMessages.length, 1);

	const reference = await store.sendDirect({
		from: sender.agent_id,
		to: recipient.agent_id,
		body: "Read on demand",
		delivery: "reference",
	});
	await waitFor(() => nativeMessages.length === 2);
	await Promise.all(receiptEvents);
	const [unreadReference] = await store.readInbox(recipient.agent_id, { messageId: reference.metadata.id });
	assert.equal(unreadReference?.read_at, null);

	for (const handler of handlers.get("message_end") ?? []) {
		await handler({
			message: {
				role: "custom",
				customType: "unrelated-notification",
				details: { messageId: reference.metadata.id, delivery: "inline" },
			},
		}, ctx);
		await handler({
			message: {
				role: "custom",
				customType: "team-message-notification",
				details: { senderName: "Team responsibilities" },
			},
		}, ctx);
		await handler({
			message: {
				role: "custom",
				customType: "team-message-notification",
				details: { messageId: 42 },
			},
		}, ctx);
	}
	const [stillUnreadReference] = await store.readInbox(recipient.agent_id, { messageId: reference.metadata.id });
	assert.equal(stillUnreadReference?.read_at, null);
});

test("terminal input injection is not present in the delivery implementation", async () => {
	const sourceRoot = new URL("../src/", import.meta.url);
	const index = await readFile(new URL("index.ts", sourceRoot), "utf8");
	const tmux = await readFile(new URL("tmux.ts", sourceRoot), "utf8");
	assert.doesNotMatch(index, /wakeTmuxAgent|paste-buffer|send-keys/);
	assert.doesNotMatch(tmux, /wakeTmuxAgent|paste-buffer|send-keys/);
	assert.doesNotMatch(index, /pi\.sendUserMessage/);
	assert.match(index, /sendNativeNotification\(pi, \{/);
	assert.match(index, /registerMessageRenderer<TeamNotificationDetails>/);
});
