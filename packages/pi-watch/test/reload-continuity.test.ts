import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

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
		sendMessage() {},
	};
	extension(pi as any);

	const ctx = {
		cwd: "/test-project",
		hasUI: false,
		ui: { notify() {}, setStatus() {} },
		sessionManager: { getSessionId: () => SESSION },
	};
	return {
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
	process.env.PI_WATCH_DIR = root;
	const harnesses: Array<ReturnType<typeof createHarness>> = [];
	t.after(async () => {
		for (const harness of harnesses) await harness.shutdown("quit").catch(() => undefined);
		if (previousRoot === undefined) delete process.env.PI_WATCH_DIR;
		else process.env.PI_WATCH_DIR = previousRoot;
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
