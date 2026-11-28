import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { InboxDelivery, MessageStore } from "../src/index.ts";

test("preserved delivery snapshots suppress completed alerts but rescan queued alerts", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "durable-inbox-handoff-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const store = new MessageStore(root);
	const hooks = {
		async resolveSender() { return { name: "sender" }; },
		formatInline(_sender: { name: string }, message: { body: string }) { return message.body.trimEnd(); },
		formatReference(_sender: { name: string }, message: { body: string }) { return message.body.trimEnd(); },
	};
	const delivered: string[] = [];
	let firstStarted!: () => void;
	const started = new Promise<void>((resolve) => { firstStarted = resolve; });
	let releaseFirst!: () => void;
	const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
	const first = new InboxDelivery(store, hooks, async (prompt) => {
		delivered.push(prompt);
		if (prompt === "FIRST") {
			firstStarted();
			await firstGate;
		}
	});
	await first.start("recipient");
	const one = await store.sendDirect({ from: "sender", to: "recipient", body: "FIRST" });
	const two = await store.sendDirect({ from: "sender", to: "recipient", body: "SECOND" });
	first.enqueue(one.metadata.id);
	await started;
	first.enqueue(two.metadata.id);
	const stopping = first.stop({ preserveDelivered: true });
	releaseFirst();
	await stopping;
	const snapshot = first.snapshotDelivered();
	assert.equal(snapshot.has(one.metadata.id), true);
	assert.equal(snapshot.has(two.metadata.id), false, "unsent queued IDs must remain eligible for rescan");
	assert.deepEqual(delivered, ["FIRST"]);

	const replacement = new InboxDelivery(store, hooks, (prompt) => {
		delivered.push(prompt);
	});
	await replacement.start("recipient", snapshot);
	await replacement.flush();
	t.after(() => replacement.stop());
	assert.deepEqual(delivered, ["FIRST", "SECOND"]);
});
