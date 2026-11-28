import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import teamExtension from "../src/index.ts";
import { TeamStore } from "../src/store.ts";

const SESSION = "team-reload-continuity";

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
		await delay(10);
	}
}

function createHarness(extension: typeof teamExtension, root: string, agentId: string) {
	const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
	const nativeMessages: Array<Record<string, unknown>> = [];
	const receiptEvents: Promise<unknown>[] = [];
	const ctx = {
		cwd: root,
		hasUI: false,
		ui: { notify() {} },
		sessionManager: {
			getSessionId: () => SESSION,
			getBranch: () => [{ type: "custom", customType: "pi-agentic-team-registration", data: { agent_id: agentId } }],
		},
	} as unknown as ExtensionContext;
	const pi = {
		registerMessageRenderer() {},
		registerCommand() {},
		registerTool() {},
		appendEntry() {},
		on(event: string, handler: (event: any, ctx: ExtensionContext) => unknown) {
			handlers.set(event, handler);
		},
		sendMessage(message: Record<string, unknown>) {
			const complete = { ...message, role: "custom" };
			nativeMessages.push(complete);
			const handler = handlers.get("message_end");
			if (handler) receiptEvents.push(Promise.resolve(handler({ message: complete }, ctx)));
		},
	} as unknown as ExtensionAPI;
	extension(pi);
	return {
		nativeMessages,
		receiptEvents,
		async start(reason: "startup" | "reload") {
			await handlers.get("session_start")?.({ reason }, ctx);
		},
		async shutdown(reason: "reload" | "quit") {
			await handlers.get("session_shutdown")?.({ reason }, ctx);
		},
	};
}

test("reload preserves team identity and notified references while cold resume retains existing semantics", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-team-reload-"));
	const store = new TeamStore(root);
	const input = {
		duties: "Reload continuity",
		sessionId: SESSION,
		cwd: root,
		pid: process.pid,
		transport: { type: "none" as const },
	};
	const sender = await store.register({ ...input, name: "Sender" });
	const recipient = await store.register({ ...input, name: "Recipient" });
	const previousRoot = process.env.PI_TEAM_DIR;
	process.env.PI_TEAM_DIR = root;
	const first = createHarness(teamExtension, root, recipient.agent_id);
	let second: ReturnType<typeof createHarness> | undefined;
	let third: ReturnType<typeof createHarness> | undefined;
	t.after(async () => {
		await third?.shutdown("quit").catch(() => undefined);
		await second?.shutdown("quit").catch(() => undefined);
		await first.shutdown("quit").catch(() => undefined);
		Reflect.deleteProperty(globalThis, Symbol.for("pi-agentic-team.reload-bridge"));
		if (previousRoot === undefined) delete process.env.PI_TEAM_DIR;
		else process.env.PI_TEAM_DIR = previousRoot;
		await rm(root, { recursive: true, force: true });
	});

	await first.start("startup");
	const beforeReload = await store.getAgent(recipient.agent_id);
	const reference = await store.sendDirect({
		from: sender.agent_id,
		to: recipient.agent_id,
		body: "Reference remains unread",
		delivery: "reference",
	});
	await waitFor(() => first.nativeMessages.length === 1, "initial reference notification");
	await Promise.all(first.receiptEvents);
	assert.equal((await store.readInbox(recipient.agent_id, { messageId: reference.metadata.id }))[0]?.read_at, null);

	await first.shutdown("reload");
	assert.deepEqual(await store.getAgent(recipient.agent_id), beforeReload, "reload must not deactivate or re-register");
	const duringHandoff = await store.sendDirect({
		from: sender.agent_id,
		to: recipient.agent_id,
		body: "Generated while no watcher is attached",
	});

	const reloadSpecifier = "../src/index.ts?team-reload-continuity";
	const reloadedExtension = (await import(reloadSpecifier)).default as typeof teamExtension;
	second = createHarness(reloadedExtension, root, recipient.agent_id);
	await second.start("reload");
	await waitFor(() => second!.nativeMessages.length === 1, "handoff backlog notification");
	await Promise.all(second.receiptEvents);
	assert.match(String(second.nativeMessages[0]!.content), /Generated while no watcher is attached/);
	assert.doesNotMatch(String(second.nativeMessages[0]!.content), new RegExp(reference.metadata.id));
	assert.deepEqual(await store.getAgent(recipient.agent_id), beforeReload, "adoption preserves identity and registration fields");
	assert.equal((await store.readInbox(recipient.agent_id, { messageId: reference.metadata.id }))[0]?.read_at, null);
	assert.equal((await store.readInbox(recipient.agent_id, { messageId: duringHandoff.metadata.id }))[0]?.read_at !== null, true);

	await second.shutdown("quit");
	assert.equal((await store.getAgent(recipient.agent_id)).status, "inactive");
	const restartSpecifier = "../src/index.ts?team-cold-resume-continuity";
	const restartedExtension = (await import(restartSpecifier)).default as typeof teamExtension;
	third = createHarness(restartedExtension, root, recipient.agent_id);
	await third.start("startup");
	await waitFor(() => third!.nativeMessages.length === 1, "cold-start unread reference replay");
	assert.match(String(third.nativeMessages[0]!.content), new RegExp(reference.metadata.id));
	const cold = await store.getAgent(recipient.agent_id);
	assert.equal(cold.agent_id, beforeReload.agent_id);
	assert.notEqual(cold.instance_id, beforeReload.instance_id);
	assert.equal(cold.status, "active");
});
