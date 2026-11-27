import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import backgroundJobsExtension from "../src/index.ts";
import type { JobTask } from "../src/types.ts";

const SESSION = "background-job-reload-session";

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + 3_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
		await delay(10);
	}
}

function createHarness(extension: typeof backgroundJobsExtension) {
	const handlers = new Map<string, (event: any, ctx: any) => Promise<void>>();
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const busHandlers = new Map<string, Set<(event: any) => void>>();
	const notifications: any[] = [];
	const statuses: Array<string | undefined> = [];
	const pi = {
		events: {
			on(name: string, handler: (event: any) => void) {
				const existing = busHandlers.get(name) ?? new Set();
				existing.add(handler);
				busHandlers.set(name, existing);
				return () => existing.delete(handler);
			},
			emit() {},
		},
		on(name: string, handler: (event: any, ctx: any) => Promise<void>) {
			handlers.set(name, handler);
		},
		registerMessageRenderer() {},
		registerCommand(name: string, definition: any) { commands.set(name, definition); },
		registerTool(definition: any) {
			tools.set(definition.name, { ...definition, sourceInfo: { extensionPath: "pi-background-jobs" } });
		},
		getAllTools() { return [...tools.values()]; },
		sendMessage(message: unknown) { notifications.push(message); },
	};
	extension(pi as any);
	const ctx = {
		cwd: "/tmp",
		hasUI: true,
		ui: {
			notify() {},
			setStatus(_key: string, text: string | undefined) { statuses.push(text); },
		},
		sessionManager: { getSessionId: () => SESSION },
	};
	return {
		notifications,
		statuses,
		busHandlers,
		async start(reason: "startup" | "reload") { await handlers.get("session_start")!({ reason }, ctx); },
		async shutdown(reason: "reload" | "quit") { await handlers.get("session_shutdown")!({ reason }, ctx); },
		async call(name: string, params: Record<string, unknown>) {
			return tools.get(name).execute(`call-${name}`, params, undefined, undefined, ctx);
		},
		async command(args = "") { await commands.get("jobs").handler(args, ctx); },
	};
}

test("fresh-module reload preserves PID and logs, then restart retains only history", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-background-jobs-reload-"));
	const marker = join(root, "pids");
	const previousRoot = process.env.PI_JOBS_DIR;
	process.env.PI_JOBS_DIR = root;
	const harnesses: Array<ReturnType<typeof createHarness>> = [];
	t.after(async () => {
		for (const harness of harnesses) await harness.shutdown("quit").catch(() => undefined);
		if (previousRoot === undefined) delete process.env.PI_JOBS_DIR;
		else process.env.PI_JOBS_DIR = previousRoot;
		await rm(root, { recursive: true, force: true });
	});

	const first = createHarness(backgroundJobsExtension);
	harnesses.push(first);
	await first.start("startup");
	const started = (await first.call("job_run", {
		name: "Reload continuity",
		command: `echo $$ >> ${marker}; sleep 0.4; echo finished`,
	})).details.task as JobTask;
	const originalPid = started.pid;
	assert.ok(originalPid);
	assert.match(first.statuses.at(-1) ?? "", /1 job running/);
	assert.match(first.statuses.at(-1) ?? "", /48;2;183;223;255/);

	await first.shutdown("reload");
	assert.equal([...first.busHandlers.values()].reduce((sum, handlers) => sum + handlers.size, 0), 0);
	const reloadSpecifier = "../src/index.ts?jobs-reload-test";
	const secondExtension = (await import(reloadSpecifier)).default as typeof backgroundJobsExtension;
	const second = createHarness(secondExtension);
	harnesses.push(second);
	await second.start("reload");
	const adopted = (await second.call("job_status", { taskId: started.id })).details.tasks[0] as JobTask;
	assert.equal(adopted.pid, originalPid, "reload retained the exact child PID");
	assert.equal((await readFile(marker, "utf8")).trim().split("\n").length, 1, "reload did not rerun the command");
	await waitFor(() => second.notifications.length === 1, "one terminal notification after reload");
	assert.equal(first.notifications.length, 0);
	assert.equal(second.notifications[0].customType, "background-job-finished");
	assert.equal(second.notifications[0].details.status, "completed");
	assert.match(second.statuses.at(-1) ?? "", /1 finished/);
	assert.doesNotMatch(second.statuses.at(-1) ?? "", /\x1b\[/, "finished-only footer has no ANSI background");
	assert.match(await readFile(started.output_path, "utf8"), /finished\n/);
	await second.command();
	assert.equal(second.statuses.at(-1), undefined, "/jobs clears unseen terminal footer state");

	await second.shutdown("quit");
	const restartSpecifier = "../src/index.ts?jobs-restart-test";
	const thirdExtension = (await import(restartSpecifier)).default as typeof backgroundJobsExtension;
	const third = createHarness(thirdExtension);
	harnesses.push(third);
	await third.start("startup");
	const historical = (await third.call("job_status", { taskId: started.id })).details.tasks[0] as JobTask;
	assert.equal(historical.status, "completed");
	assert.equal(historical.pid, null);
	assert.equal(third.notifications.length, 0);
	assert.equal((await readFile(marker, "utf8")).trim().split("\n").length, 1, "cold restart did not relaunch history");
	await third.command("clear");
	await assert.rejects(() => third.call("job_status", { taskId: started.id }), /job not found/);
	await assert.rejects(() => readFile(started.output_path), /ENOENT/);
});
