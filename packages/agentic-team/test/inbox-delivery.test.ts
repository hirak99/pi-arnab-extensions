import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

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
		// Models pi.sendUserMessage(): no terminal writes and no draft mutation.
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
	});
	await waitFor(() => nativeMessages.length === 1);
	assert.doesNotMatch(nativeMessages[0]!, /SENSITIVE BODY/);
	assert.match(nativeMessages[0]!, new RegExp(message.metadata.id));
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

test("terminal input injection is not present in the delivery implementation", async () => {
	const sourceRoot = new URL("../src/", import.meta.url);
	const index = await readFile(new URL("index.ts", sourceRoot), "utf8");
	const tmux = await readFile(new URL("tmux.ts", sourceRoot), "utf8");
	assert.doesNotMatch(index, /wakeTmuxAgent|paste-buffer|send-keys/);
	assert.doesNotMatch(tmux, /wakeTmuxAgent|paste-buffer|send-keys/);
	assert.match(index, /pi\.sendUserMessage\(prompt/);
});
