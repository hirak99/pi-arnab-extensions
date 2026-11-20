import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { TeamStore } from "../src/store.ts";
import type { RegistrationInput } from "../src/types.ts";

function makeInput(overrides: Partial<RegistrationInput> = {}): RegistrationInput {
	return {
		duties: "Run the test suite",
		name: "tester",
		sessionId: `session-${randomUUID()}`,
		cwd: "/tmp/work",
		pid: process.pid,
		transport: { type: "none" },
		...overrides,
	};
}

async function withStore(t: test.TestContext): Promise<TeamStore> {
	const root = await mkdtemp(join(tmpdir(), "team-store-test-"));
	t.after(async () => {
		await rm(root, { recursive: true, force: true });
	});
	return new TeamStore(root);
}

test("registration assigns agent and instance UUIDs and persists them", async (t) => {
	const store = await withStore(t);
	const input = makeInput();
	const registration = await store.register(input);

	assert.match(registration.agent_id, /^[0-9a-f-]{36}$/i);
	assert.match(registration.instance_id, /^[0-9a-f-]{36}$/i);
	assert.notEqual(registration.agent_id, registration.instance_id);
	assert.equal(registration.status, "active");
	assert.equal(registration.name, input.name);
	assert.equal(registration.duties, input.duties);

	const fetched = await store.getAgent(registration.agent_id);
	assert.deepEqual(fetched, registration);
});

test("reactivation preserves agent UUID and rotates instance UUID", async (t) => {
	const store = await withStore(t);
	const original = await store.register(makeInput());

	assert.equal(await store.deactivate(original.agent_id, original.instance_id), true);

	const reactivated = await store.register(makeInput({ name: "tester-2" }), original.agent_id);
	assert.equal(reactivated.agent_id, original.agent_id);
	assert.notEqual(reactivated.instance_id, original.instance_id);
	assert.equal(reactivated.status, "active");
	assert.equal(reactivated.name, "tester-2");
	assert.equal(reactivated.registered_at, original.registered_at);
	assert.equal(reactivated.inactivated_at, undefined);
	assert.equal(reactivated.deleted_at, undefined);
});

test("responsibility updates are revisioned without changing identity", async (t) => {
	const store = await withStore(t);
	const original = await store.register(makeInput());
	assert.equal(original.responsibilities_revision, 1);

	const updated = await store.updateResponsibilities(original.agent_id, "Review pull requests and run checks");
	assert.equal(updated.agent_id, original.agent_id);
	assert.equal(updated.instance_id, original.instance_id);
	assert.equal(updated.duties, "Review pull requests and run checks");
	assert.equal(updated.responsibilities_revision, 2);
	assert.equal(typeof updated.responsibilities_updated_at, "string");

	await assert.rejects(() => store.updateResponsibilities(original.agent_id, "   "), /must not be empty/);
	const fetched = await store.getAgent(original.agent_id);
	assert.equal(fetched.responsibilities_revision, 2);
	assert.equal(fetched.duties, updated.duties);
});

test("deactivation requires the matching instance UUID", async (t) => {
	const store = await withStore(t);
	const registration = await store.register(makeInput());

	// A well-formed but wrong instance UUID must not deactivate the agent.
	assert.equal(await store.deactivate(registration.agent_id, randomUUID()), false);
	assert.equal((await store.getAgent(registration.agent_id)).status, "active");

	// The matching instance UUID deactivates exactly once.
	assert.equal(await store.deactivate(registration.agent_id, registration.instance_id), true);
	const after = await store.getAgent(registration.agent_id);
	assert.equal(after.status, "inactive");
	assert.deepEqual(after.transport, { type: "none" });
	assert.equal(typeof after.inactivated_at, "string");

	// Deactivating again (already inactive) returns false.
	assert.equal(await store.deactivate(registration.agent_id, registration.instance_id), false);
});

test("active deletion requires confirmation and archives while keeping message history", async (t) => {
	const store = await withStore(t);
	const sender = await store.register(makeInput({ name: "sender" }));
	const recipient = await store.register(makeInput({ name: "recipient" }));

	const direct = await store.sendDirect({ from: sender.agent_id, to: recipient.agent_id, body: "hello" });
	const channelPost = await store.postChannel({ from: sender.agent_id, channel: "general", body: "broadcast" });

	// Deleting an active agent without confirmation must fail.
	await assert.rejects(
		() => store.deleteAgent(recipient.agent_id),
		/deleting an active agent requires confirm=true/,
	);

	// Confirmed deletion archives the agent and removes it from the active registry.
	const deleted = await store.deleteAgent(recipient.agent_id, true);
	assert.equal(deleted.status, "deleted");
	assert.equal(deleted.agent_id, recipient.agent_id);
	assert.equal(typeof deleted.deleted_at, "string");
	await assert.rejects(() => store.getAgent(recipient.agent_id));
	const archived = await store.getArchivedAgent(recipient.agent_id);
	assert.equal(archived.status, "deleted");
	assert.equal(archived.agent_id, recipient.agent_id);

	// Inbox and channel history must survive the deletion.
	const inbox = await store.readInbox(recipient.agent_id);
	assert.equal(inbox.length, 1);
	assert.equal(inbox[0]!.metadata.id, direct.metadata.id);
	const channel = await store.readChannel("general");
	assert.equal(channel.length, 1);
	assert.equal(channel[0]!.metadata.id, channelPost.metadata.id);
});

test("direct messages persist and record automatic-style read receipts", async (t) => {
	const store = await withStore(t);
	const from = randomUUID();
	const to = randomUUID();

	const sent = await store.sendDirect({ from, to, body: "first message" });
	assert.equal(sent.metadata.from, from);
	assert.equal(sent.metadata.to, to);
	assert.equal(sent.metadata.channel, null);
	assert.equal(sent.body, "first message\n");
	assert.equal(sent.read_at, null);

	// Read the full inbox.
	const inbox = await store.readInbox(to);
	assert.equal(inbox.length, 1);
	assert.equal(inbox[0]!.metadata.id, sent.metadata.id);
	assert.equal(inbox[0]!.body, "first message\n");
	assert.equal(inbox[0]!.read_at, null);

	// The sender's inbox is unaffected.
	assert.deepEqual(await store.readInbox(from), []);

	// Read a single message by ID.
	const [single] = await store.readInbox(to, { messageId: sent.metadata.id });
	assert.equal(single!.metadata.id, sent.metadata.id);

	const beforeRead = await store.getMessageStatus(from, sent.metadata.id);
	assert.equal(beforeRead.read, false);
	assert.equal(beforeRead.read_at, null);

	// Only the addressed recipient can mark a message read.
	await assert.rejects(() => store.markRead(from, sent.metadata.id));
	const receipt = await store.markRead(to, sent.metadata.id);
	assert.equal(receipt.message_id, sent.metadata.id);
	assert.equal(typeof receipt.read_at, "string");
	assert.deepEqual(await store.markRead(to, sent.metadata.id), receipt);

	// Reading never removes or hides message history.
	const including = await store.readInbox(to);
	assert.equal(including.length, 1);
	assert.equal(including[0]!.read_at, receipt.read_at);
	const afterRead = await store.getMessageStatus(from, sent.metadata.id);
	assert.equal(afterRead.read, true);
	assert.equal(afterRead.read_at, receipt.read_at);
	await assert.rejects(() => store.getMessageStatus(to, sent.metadata.id), /only the sender/);
});

test("channel posts persist and are readable", async (t) => {
	const store = await withStore(t);
	const from = randomUUID();

	const first = await store.postChannel({ from, channel: "general", body: "post one" });
	const second = await store.postChannel({ from, channel: "general", body: "post two", replyTo: first.metadata.id });

	assert.equal(first.metadata.channel, "general");
	assert.equal(first.metadata.to, null);
	assert.equal(second.metadata.reply_to, first.metadata.id);

	const messages = await store.readChannel("general");
	assert.equal(messages.length, 2);
	assert.deepEqual(
		messages.map((message) => message.metadata.id).sort(),
		[first.metadata.id, second.metadata.id].sort(),
	);
	assert.deepEqual(
		messages.map((message) => message.body.trim()).sort(),
		["post one", "post two"],
	);

	// A channel with no posts reads as empty.
	assert.deepEqual(await store.readChannel("empty-channel"), []);
});

test("invalid channel names are rejected", async (t) => {
	const store = await withStore(t);
	const from = randomUUID();

	for (const bad of ["Upper", "has space", "-leading-dash", ".dot", "a/b", "x".repeat(65)]) {
		await assert.rejects(
			() => store.postChannel({ from, channel: bad, body: "nope" }),
			/channel must match/,
			`postChannel should reject ${JSON.stringify(bad)}`,
		);
		await assert.rejects(
			() => store.readChannel(bad),
			/channel must match/,
			`readChannel should reject ${JSON.stringify(bad)}`,
		);
	}
});

test("read receipts preserve inbox history and limit validation", async (t) => {
	const store = await withStore(t);
	const from = randomUUID();
	const to = randomUUID();

	const first = await store.sendDirect({ from, to, body: "one" });
	await store.sendDirect({ from, to, body: "two" });
	await store.sendDirect({ from, to, body: "three" });

	// Reading does not filter or remove messages from inbox history.
	assert.equal((await store.readInbox(to)).length, 3);
	await store.markRead(to, first.metadata.id);
	const history = await store.readInbox(to);
	assert.equal(history.length, 3);
	assert.equal(history.find((message) => message.metadata.id === first.metadata.id)?.read_at !== null, true);

	// Limit restricts the number of returned messages.
	assert.equal((await store.readInbox(to, { limit: 1 })).length, 1);

	// Invalid limits are rejected for both inbox and channel reads.
	// (readChannel validates the limit only once the channel directory exists.)
	await store.postChannel({ from, channel: "limits", body: "seed" });
	for (const bad of [0, 201, 1.5, Number.NaN]) {
		await assert.rejects(
			() => store.readInbox(to, { limit: bad }),
			/limit must be an integer from 1 to 200/,
			`readInbox should reject limit ${bad}`,
		);
		await assert.rejects(
			() => store.readChannel("limits", { limit: bad }),
			/limit must be an integer from 1 to 200/,
			`readChannel should reject limit ${bad}`,
		);
	}

	// Boundary limits are accepted.
	await store.readInbox(to, { limit: 1 });
	await store.readInbox(to, { limit: 200 });
});

test("delivery locks serialize concurrent writers to one recipient", async (t) => {
	const store = await withStore(t);
	const recipient = randomUUID();
	let active = 0;
	let maximumActive = 0;
	let completed = 0;

	await Promise.all([
		store.withDeliveryLock(recipient, async () => {
			active += 1;
			maximumActive = Math.max(maximumActive, active);
			await delay(20);
			completed += 1;
			active -= 1;
		}),
		store.withDeliveryLock(recipient, async () => {
			active += 1;
			maximumActive = Math.max(maximumActive, active);
			await delay(20);
			completed += 1;
			active -= 1;
		}),
	]);

	assert.equal(completed, 2);
	assert.equal(maximumActive, 1);
});
