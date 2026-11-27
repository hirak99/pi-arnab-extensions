import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { InboxDelivery, MessageStore } from "../src/index.ts";

async function withStore(t: test.TestContext): Promise<MessageStore> {
	const root = await mkdtemp(join(tmpdir(), "durable-inbox-test-"));
	t.after(async () => {
		await rm(root, { recursive: true, force: true });
	});
	return new MessageStore(root);
}

test("direct messages persist and read receipts are idempotent", async (t) => {
	const store = await withStore(t);
	const from = randomUUID();
	const to = randomUUID();

	const sent = await store.sendDirect({ from, to, body: "event payload" });
	assert.equal(sent.body, "event payload\n");
	assert.equal(sent.read_at, null);

	const inbox = await store.readInbox(to);
	assert.equal(inbox.length, 1);

	const receipt = await store.markRead(to, sent.metadata.id);
	assert.deepEqual(await store.markRead(to, sent.metadata.id), receipt);
	await assert.rejects(() => store.markRead(from, sent.metadata.id));
	assert.equal((await store.readInbox(to))[0]!.read_at, receipt.read_at);
});

test("storage-layout constraints reject invalid direct messages and limits", async (t) => {
	const store = await withStore(t);
	// Limit validation applies once the inbox exists (matches existing behavior).
	await store.sendDirect({ from: "x", to: "y", body: "seed" });
	await assert.rejects(() => store.readInbox("y", { limit: 500 }), /limit must be an integer from 1 to 200/);
	await assert.rejects(() => store.sendDirect({ from: "x", to: "y", body: "   " }), /must not be empty/);
	// Identity shape is the consumer's concern: non-UUID recipients work fine here.
	await store.sendDirect({ from: "sender-1", to: "session-abc", body: "ok" });
	assert.equal((await store.readInbox("session-abc")).length, 1);
});

test("delivery locks serialize concurrent writers to one recipient", async (t) => {
	const store = await withStore(t);
	let active = 0;
	let maximumActive = 0;
	await Promise.all([
		store.withDeliveryLock("recipient", async () => {
			active += 1;
			maximumActive = Math.max(maximumActive, active);
			await delay(20);
			active -= 1;
		}),
		store.withDeliveryLock("recipient", async () => {
			active += 1;
			maximumActive = Math.max(maximumActive, active);
			await delay(20);
			active -= 1;
		}),
	]);
	assert.equal(maximumActive, 1);
});

test("delivery watcher renders via consumer hooks and honors read receipts", async (t) => {
	const store = await withStore(t);
	const delivered: string[] = [];
	const delivery = new InboxDelivery(
		store,
		{
			async resolveSender(message) {
				return { name: `sender-${message.metadata.from}` };
			},
			formatInline(sender, message) {
				return `${sender.name} >> ${message.body.trimEnd()}`;
			},
			formatReference(sender, message) {
				return `${sender.name} withheld a message (${message.metadata.id})`;
			},
		},
		(prompt) => {
			delivered.push(prompt);
		},
	);
	await delivery.start("recipient-1");
	t.after(() => delivery.stop());

	const inline = await store.sendDirect({ from: "a", to: "recipient-1", body: "VISIBLE" });
	const reference = await store.sendDirect({ from: "b", to: "recipient-1", body: "HIDDEN", delivery: "reference" });

	// Deliver the first two deterministically, then stop the watcher before
	// recording the read receipt on a third message.
	const deadline = Date.now() + 2_000;
	while (delivered.length < 2 && Date.now() < deadline) await delay(10);
	await delivery.stop();

	const read = await store.sendDirect({ from: "c", to: "recipient-1", body: "ALREADY READ" });
	await store.markRead("recipient-1", read.metadata.id);
	await delivery.start("recipient-1");
	await delivery.flush();

	// Unread messages are re-delivered on watcher restart (startup backlog).
	assert.equal(delivered.length, 4);
	const visibleCount = delivered.filter((prompt) => prompt.includes("sender-a >> VISIBLE")).length;
	const withheldCount = delivered.filter((prompt) => prompt.includes("withheld")).length;
	assert.equal(visibleCount, 2);
	assert.equal(withheldCount, 2);
	assert.ok(!delivered.some((prompt) => prompt.includes("HIDDEN")));
	assert.ok(!delivered.some((prompt) => prompt.includes("ALREADY READ")));

	delivery.enqueue(inline.metadata.id);
	await delivery.flush();
	assert.equal(delivered.length, 4, "duplicate enqueue must not redeliver");
});
