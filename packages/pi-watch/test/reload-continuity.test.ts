import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { MessageStore } from "pi-durable-inbox";

import watchExtension from "../src/index.ts";

const SESSION = "reload-continuity-session";

async function waitFor(predicate: () => boolean | Promise<boolean>, what: string): Promise<void> {
	const deadline = Date.now() + 3_000;
	while (!(await predicate())) {
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
		await delay(10);
	}
}

function createHarness(extension: typeof watchExtension = watchExtension) {
	const handlers = new Map<string, (event: any, ctx: any) => Promise<void>>();
	const tools = new Map<string, any>();
	const busHandlers = new Map<string, Set<(event: any) => void>>();
	const nativeMessages: Array<Record<string, unknown>> = [];
	const pi = {
		events: {
			on(name: string, handler: (event: any) => void) {
				const existing = busHandlers.get(name) ?? new Set();
				existing.add(handler);
				busHandlers.set(name, existing);
				return () => existing.delete(handler);
			},
		},
		on(name: string, handler: (event: any, ctx: any) => Promise<void>) {
			handlers.set(name, handler);
		},
		registerMessageRenderer() {},
		registerTool(definition: any) {
			tools.set(definition.name, { ...definition, sourceInfo: { extensionPath: "pi-watch" } });
		},
		getAllTools() {
			return [...tools.values()];
		},
		sendMessage(message: Record<string, unknown>) {
			nativeMessages.push(message);
		},
	};
	extension(pi as any);

	const ctx = {
		cwd: "/test-project",
		hasUI: false,
		ui: { notify() {}, setStatus() {} },
		sessionManager: { getSessionId: () => SESSION },
	};
	return {
		nativeMessages,
		async start(reason: "startup" | "reload") {
			await handlers.get("session_start")!({ reason }, ctx);
		},
		async shutdown(reason: "reload" | "quit") {
			await handlers.get("session_shutdown")!({ reason }, ctx);
		},
		async call(name: string, params: Record<string, unknown>) {
			return tools.get(name).execute(`call-${name}`, params, undefined, undefined, ctx);
		},
	};
}

test("reload preserves the live watch process; full restart auto-resumes it", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-watch-reload-"));
	const marker = join(root, "script-pids");
	const previousRoot = process.env.PI_WATCH_DIR;
	const previousLogRoot = process.env.PI_WATCH_LOG_DIR;
	process.env.PI_WATCH_DIR = root;
	process.env.PI_WATCH_LOG_DIR = join(root, "logs");
	const harnesses: Array<ReturnType<typeof createHarness>> = [];
	t.after(async () => {
		for (const harness of harnesses) await harness.shutdown("quit").catch(() => undefined);
		if (previousRoot === undefined) delete process.env.PI_WATCH_DIR;
		else process.env.PI_WATCH_DIR = previousRoot;
		if (previousLogRoot === undefined) delete process.env.PI_WATCH_LOG_DIR;
		else process.env.PI_WATCH_LOG_DIR = previousLogRoot;
		await rm(root, { recursive: true, force: true });
	});

	const first = createHarness();
	harnesses.push(first);
	await first.start("startup");
	const created = await first.call("watch_create_stream", {
		name: "continuity",
		run: `echo $$ >> ${marker}; while true; do sleep 1; done`,
	});
	assert.deepEqual(created.content, [{ type: "text", text: "Watch created." }]);
	const listed = (await first.call("watch_list", {})).details;
	assert.equal(listed.watch_root, undefined);
	assert.deepEqual(Object.keys(listed.watches[0]).sort(), [
		"broken",
		"event_count",
		"every_seconds",
		"last_fired_at",
		"mode",
		"name",
		"next_run_at",
		"status",
	].sort());
	const inspect = async (harness: ReturnType<typeof createHarness>) =>
		(await harness.call("watch_inspect", { name: "continuity" })).details;
	await waitFor(async () => (await inspect(first)).state.pid !== null, "initial stream PID");
	const originalPid = (await inspect(first)).state.pid as number;

	await first.shutdown("reload");
	const reloadSpecifier = "../src/index.ts?reload-continuity";
	const reloadedExtension = (await import(reloadSpecifier)).default as typeof watchExtension;
	const second = createHarness(reloadedExtension);
	harnesses.push(second);
	await second.start("reload");
	assert.equal((await inspect(second)).state.pid, originalPid, "reload adopted the same child process");
	assert.equal((await readFile(marker, "utf8")).trim().split("\n").length, 1, "reload did not rerun the command");

	await second.shutdown("quit");
	const restartSpecifier = "../src/index.ts?full-restart-continuity";
	const restartedExtension = (await import(restartSpecifier)).default as typeof watchExtension;
	const third = createHarness(restartedExtension);
	harnesses.push(third);
	await third.start("startup");
	await waitFor(async () => {
		const state = (await inspect(third)).state;
		const runs = (await readFile(marker, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).length;
		return state.pid !== null && state.pid !== originalPid && runs === 2;
	}, "full-restart replacement PID and command write");
	assert.equal((await readFile(marker, "utf8")).trim().split("\n").length, 2, "full restart ran the command once more");

	const paused = await third.call("watch_pause", { name: "continuity" });
	assert.deepEqual(paused.content, [{ type: "text", text: "Watch paused." }]);
	const resumed = await third.call("watch_resume", { name: "continuity" });
	assert.deepEqual(resumed.content, [{ type: "text", text: "Watch resumed." }]);
	const removed = await third.call("watch_remove", { name: "continuity" });
	assert.deepEqual(removed.content, [{ type: "text", text: "Watch removed." }]);
});

test("reload preserves removed-watch sender identity and awaits durable notification receipts", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-watch-reload-identity-"));
	const previousRoot = process.env.PI_WATCH_DIR;
	const previousLogRoot = process.env.PI_WATCH_LOG_DIR;
	process.env.PI_WATCH_DIR = root;
	process.env.PI_WATCH_LOG_DIR = join(root, "logs");
	const first = createHarness();
	let second: ReturnType<typeof createHarness> | undefined;
	t.after(async () => {
		await second?.shutdown("quit").catch(() => undefined);
		await first.shutdown("quit").catch(() => undefined);
		if (previousRoot === undefined) delete process.env.PI_WATCH_DIR;
		else process.env.PI_WATCH_DIR = previousRoot;
		if (previousLogRoot === undefined) delete process.env.PI_WATCH_LOG_DIR;
		else process.env.PI_WATCH_LOG_DIR = previousLogRoot;
		await rm(root, { recursive: true, force: true });
	});

	await first.start("startup");
	await first.call("watch_create_stream", {
		name: "removed-stream",
		run: "echo final; while true; do sleep 1; done",
		max_events: 1,
	});
	await waitFor(() => first.nativeMessages.length === 1, "initial capped notification");
	const outbox = new MessageStore(join(root, "outbox"));
	const initialNotification = first.nativeMessages[0] as any;
	const [initialMessage] = await outbox.readInbox(SESSION, { messageId: initialNotification.details.messageId });
	const watchId = initialMessage!.metadata.from.slice("watch:".length);
	await first.shutdown("reload");

	// Simulate the final capped/removed-watch alert becoming visible to the
	// replacement runtime's backlog scan.
	const pending = await outbox.sendDirect({ from: `watch:${watchId}`, to: SESSION, body: "Final alert" });
	const reloadSpecifier = "../src/index.ts?reload-removed-identity";
	const reloadedExtension = (await import(reloadSpecifier)).default as typeof watchExtension;
	second = createHarness(reloadedExtension);
	await second.start("reload");
	await waitFor(() => second!.nativeMessages.length === 1, "removed-watch notification");
	const notification = second.nativeMessages[0] as any;
	assert.equal(notification.details.senderName, 'watch "removed-stream" (stream)');
	await waitFor(async () => {
		const [message] = await outbox.readInbox(SESSION, { messageId: pending.metadata.id });
		return message?.read_at !== null;
	}, "durable watch receipt");
	const [receipt] = await outbox.readInbox(SESSION, { messageId: pending.metadata.id });
	assert.equal(receipt?.read_at !== null, true);
});
