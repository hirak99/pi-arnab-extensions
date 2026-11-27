import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MessageStore } from "../src/store.ts";

test("direct messages persist optional broadcast metadata", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-inbox-broadcast-"));
	const store = new MessageStore(root);
	t.after(() => rm(root, { recursive: true, force: true }));
	const broadcastId = randomUUID();
	const recipient = randomUUID();

	const sent = await store.sendDirect({
		from: randomUUID(),
		to: recipient,
		body: "Broadcast body",
		broadcastId,
		teams: ["dev", "ops"],
	});
	assert.equal(sent.metadata.broadcast_id, broadcastId);
	assert.deepEqual(sent.metadata.teams, ["dev", "ops"]);

	const [read] = await store.readInbox(recipient, { messageId: sent.metadata.id });
	assert.equal(read?.metadata.broadcast_id, broadcastId);
	assert.deepEqual(read?.metadata.teams, ["dev", "ops"]);
	assert.equal(read?.body, "Broadcast body\n");
});
