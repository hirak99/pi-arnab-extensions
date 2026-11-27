import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import teamExtension from "../src/index.ts";
import { TeamStore } from "../src/store.ts";

test("team mutation and identity tools return focused payloads", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-team-tool-results-"));
	const previousRoot = process.env.PI_TEAM_DIR;
	process.env.PI_TEAM_DIR = root;
	const tools = new Map<string, any>();
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<unknown>>();
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
	const ctx = {
		cwd: root,
		hasUI: false,
		sessionManager: {
			getSessionId: () => "tool-results-test",
			getBranch: () => [],
		},
	} as unknown as ExtensionContext;
	teamExtension(pi);
	t.after(async () => {
		await handlers.get("session_shutdown")?.({}, ctx);
		if (previousRoot === undefined) delete process.env.PI_TEAM_DIR;
		else process.env.PI_TEAM_DIR = previousRoot;
		await rm(root, { recursive: true, force: true });
	});

	const registered = await tools.get("team_register").execute("register", {
		duties: "Test focused tool results",
		name: "Self",
		teams: ["test"],
	}, undefined, undefined, ctx);
	assert.deepEqual(registered.details, { agent_id: registered.details.agent_id });
	assert.equal(typeof registered.details.agent_id, "string");

	const store = new TeamStore(root);
	const other = await store.register({
		duties: "Other test agent",
		name: "Other",
		sessionId: "other-session",
		cwd: root,
		pid: process.pid,
		transport: { type: "none" },
	});
	const deleted = await tools.get("team_delete_member").execute("delete", {
		agent_id: other.agent_id,
		confirm: true,
	});
	assert.deepEqual(deleted.details, { deleted: other.agent_id, inbox_preserved: true });
});
