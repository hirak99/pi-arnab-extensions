import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import teamExtension from "../src/index.ts";
import { TeamStore } from "../src/store.ts";

test("team_broadcast resolves team unions and all active agents with durable delivery", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-team-broadcast-"));
	const store = new TeamStore(root);
	const input = {
		duties: "Broadcast test agent",
		sessionId: "broadcast-test",
		cwd: root,
		pid: process.pid,
		transport: { type: "none" as const },
	};
	const sender = await store.register({ ...input, name: "Sender" });
	const dev = await store.register({ ...input, name: "Dev", teams: ["dev"] });
	const dual = await store.register({ ...input, name: "Dual", teams: ["dev", "ops"] });
	const ops = await store.register({ ...input, name: "Ops", teams: ["ops"] });
	const unassigned = await store.register({ ...input, name: "Unassigned" });
	const inactive = await store.register({ ...input, name: "Inactive", teams: ["dev"] });
	await store.deactivate(inactive.agent_id, inactive.instance_id);

	const tools = new Map<string, any>();
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<unknown>>();
	const ctx = {
		cwd: root,
		hasUI: false,
		sessionManager: {
			getSessionId: () => "broadcast-test",
			getBranch: () => [{
				type: "custom",
				customType: "pi-agentic-team-registration",
				data: { agent_id: sender.agent_id },
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

	const broadcast = tools.get("team_broadcast");
	assert.ok(broadcast);
	assert.equal(tools.has("team_post_channel"), false, "legacy channel posting API is removed");
	assert.equal(Object.hasOwn(tools.get("team_read_messages").parameters.properties, "channel"), false);
	const devResult = (await broadcast.execute("call-dev", {
		teams: ["dev"],
		text: "Dev inline broadcast",
	})).details;
	assert.equal(devResult.recipient_count, 2);
	assert.equal(devResult.inactive_count, 1);
	assert.equal(devResult.failed_count, 0);
	assert.equal(devResult.wake_status, "queued");
	assert.deepEqual(devResult.teams, ["dev"]);
	const devRecipients = devResult.deliveries.map((delivery: { agent_id: string }) => delivery.agent_id).sort();
	assert.deepEqual(devRecipients, [dev.agent_id, dual.agent_id].sort());
	for (const delivery of devResult.deliveries) {
		const [message] = await store.readInbox(delivery.agent_id, { messageId: delivery.message_id });
		assert.equal(message?.metadata.broadcast_id, devResult.broadcast_id);
		assert.deepEqual(message?.metadata.teams, ["dev"]);
		assert.equal(message?.metadata.delivery, "inline");
		assert.equal(message?.body, "Dev inline broadcast\n");
	}
	assert.deepEqual(await store.readInbox(sender.agent_id), [], "sender is excluded");
	assert.deepEqual(await store.readInbox(ops.agent_id), [], "unselected teams are excluded");
	assert.deepEqual(await store.readInbox(unassigned.agent_id), [], "unselected unassigned agents are excluded");

	const unionResult = (await broadcast.execute("call-union", {
		teams: ["dev", "ops"],
		text: "Union reference broadcast",
		delivery: "reference",
	})).details;
	assert.equal(unionResult.recipient_count, 3, "dual-team agents are deduplicated");
	assert.equal(unionResult.inactive_count, 1);
	assert.deepEqual(
		unionResult.deliveries.map((delivery: { agent_id: string }) => delivery.agent_id).sort(),
		[dev.agent_id, dual.agent_id, ops.agent_id].sort(),
	);
	for (const delivery of unionResult.deliveries) {
		const [message] = await store.readInbox(delivery.agent_id, { messageId: delivery.message_id });
		assert.equal(message?.metadata.broadcast_id, unionResult.broadcast_id);
		assert.deepEqual(message?.metadata.teams, ["dev", "ops"]);
		assert.equal(message?.metadata.delivery, "reference");
	}

	const allResult = (await broadcast.execute("call-all", {
		text: "All-agent broadcast",
	})).details;
	assert.equal(allResult.recipient_count, 4);
	assert.equal(allResult.inactive_count, 1);
	assert.deepEqual(allResult.teams, []);
	const unassignedMessages = await store.readInbox(unassigned.agent_id);
	assert.equal(unassignedMessages.length, 1, "all-agent broadcast includes unassigned agents");
	assert.equal(unassignedMessages[0]?.metadata.broadcast_id, allResult.broadcast_id);
	assert.deepEqual(unassignedMessages[0]?.metadata.teams, []);
	assert.deepEqual(await store.readInbox(sender.agent_id), [], "no automatic acknowledgments or self-delivery");

	await assert.rejects(
		() => broadcast.execute("call-empty", { teams: [], text: "Invalid" }),
		/teams must be omitted/,
	);
	await assert.rejects(
		() => broadcast.execute("call-invalid", { teams: ["not a team"], text: "Invalid" }),
		/team names must match/,
	);
	await assert.rejects(
		() => broadcast.execute("call-invalid-body", { teams: ["dev"], text: "   " }),
		/message must not be empty/,
	);
});
