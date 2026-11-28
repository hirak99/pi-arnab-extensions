import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import backgroundJobsExtension from "../src/index.ts";
import type { JobTask } from "../src/types.ts";

const SESSION = "background-job-reload-session";

function internalOutputPath(root: string, id: string): string {
	return join(root, "output", SESSION, `${id}.output`);
}

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
	const previousOutputRoot = process.env.PI_JOBS_OUTPUT_DIR;
	process.env.PI_JOBS_DIR = root;
	process.env.PI_JOBS_OUTPUT_DIR = join(root, "output");
	const harnesses: Array<ReturnType<typeof createHarness>> = [];
	t.after(async () => {
		for (const harness of harnesses) await harness.shutdown("quit").catch(() => undefined);
		if (previousRoot === undefined) delete process.env.PI_JOBS_DIR;
		else process.env.PI_JOBS_DIR = previousRoot;
		if (previousOutputRoot === undefined) delete process.env.PI_JOBS_OUTPUT_DIR;
		else process.env.PI_JOBS_OUTPUT_DIR = previousOutputRoot;
		await rm(root, { recursive: true, force: true });
	});

	const first = createHarness(backgroundJobsExtension);
	harnesses.push(first);
	await first.start("startup");
	const startedResult = await first.call("job_run", {
		name: "Reload continuity",
		command: `echo $$ >> ${marker}; sleep 0.4; echo finished`,
	});
	assert.deepEqual(Object.keys(startedResult.details), ["id"]);
	const started = (await first.call("job_status", { taskId: startedResult.details.id })).details.tasks[0] as JobTask;
	assert.equal(started.command, undefined);
	assert.equal(started.session_id, undefined);
	assert.equal(started.output_path, undefined);
	const startedOutput = internalOutputPath(root, started.id);
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
	assert.equal(second.notifications[0].details.outputPath, undefined);
	assert.match(second.statuses.at(-1) ?? "", /1 finished/);
	assert.doesNotMatch(second.statuses.at(-1) ?? "", /\x1b\[/, "finished-only footer has no ANSI background");
	assert.match(await readFile(startedOutput, "utf8"), /finished\n/);
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
	await assert.rejects(() => readFile(startedOutput), /ENOENT/);
});

test("tool surface hides internal paths and job_export exceeds the inspection cap", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-background-jobs-export-"));
	const previousRoot = process.env.PI_JOBS_DIR;
	const previousOutputRoot = process.env.PI_JOBS_OUTPUT_DIR;
	process.env.PI_JOBS_DIR = root;
	process.env.PI_JOBS_OUTPUT_DIR = join(root, "output");
	const harness = createHarness(backgroundJobsExtension);
	t.after(async () => {
		await harness.shutdown("quit").catch(() => undefined);
		if (previousRoot === undefined) delete process.env.PI_JOBS_DIR;
		else process.env.PI_JOBS_DIR = previousRoot;
		if (previousOutputRoot === undefined) delete process.env.PI_JOBS_OUTPUT_DIR;
		else process.env.PI_JOBS_OUTPUT_DIR = previousOutputRoot;
		await rm(root, { recursive: true, force: true });
	});
	await harness.start("startup");
	const started = await harness.call("job_run", {
		name: "Export",
		command: "printf '%060000d' 0",
	});
	assert.deepEqual(Object.keys(started.details), ["id"]);
	await waitFor(() => harness.notifications.length === 1, "export job completion");
	const status = await harness.call("job_status", { taskId: started.details.id });
	assert.equal(status.details.tasks[0].output_path, undefined);
	const logs = await harness.call("job_logs", { taskId: started.details.id, maxBytes: 10 });
	assert.equal(logs.details.path, undefined);
	assert.equal(logs.details.task, undefined);
	assert.equal(logs.details.bytesRead, 10);
	assert.doesNotMatch(logs.content[0].text, /\.output|pi-background-jobs-export-/);
	assert.doesNotMatch(harness.notifications[0].content, /\.output/);
	assert.equal(harness.notifications[0].details.outputPath, undefined);

	const destination = join(root, "permanent", "saved.log");
	const exported = await harness.call("job_export", { taskId: started.details.id, path: destination });
	assert.deepEqual(exported.details, { bytes_written: 60_000 });
	assert.equal((await readFile(destination, "utf8")).length, 60_000);
	await harness.call("job_clear", { taskId: started.details.id });
	assert.equal((await readFile(destination, "utf8")).length, 60_000);
});

test("job_clear validates input and deletes only finished jobs", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-background-jobs-clear-"));
	const previousRoot = process.env.PI_JOBS_DIR;
	const previousOutputRoot = process.env.PI_JOBS_OUTPUT_DIR;
	process.env.PI_JOBS_DIR = root;
	process.env.PI_JOBS_OUTPUT_DIR = join(root, "output");
	const harness = createHarness(backgroundJobsExtension);
	t.after(async () => {
		await harness.shutdown("quit").catch(() => undefined);
		if (previousRoot === undefined) delete process.env.PI_JOBS_DIR;
		else process.env.PI_JOBS_DIR = previousRoot;
		if (previousOutputRoot === undefined) delete process.env.PI_JOBS_OUTPUT_DIR;
		else process.env.PI_JOBS_OUTPUT_DIR = previousOutputRoot;
		await rm(root, { recursive: true, force: true });
	});
	await harness.start("startup");
	const running = (await harness.call("job_run", {
		name: "Running",
		command: "sleep 60",
	})).details as { id: string };
	const completed = (await harness.call("job_run", {
		name: "Completed",
		command: "printf completed",
	})).details as { id: string };
	const failed = (await harness.call("job_run", {
		name: "Failed",
		command: "exit 7",
	})).details as { id: string };
	await waitFor(() => harness.notifications.length === 2, "two terminal jobs");

	await assert.rejects(() => harness.call("job_clear", {}), /exactly one/);
	await assert.rejects(() => harness.call("job_clear", { allFinished: false }), /must be true/);
	await assert.rejects(
		() => harness.call("job_clear", { taskId: completed.id, allFinished: true }),
		/exactly one/,
	);
	await assert.rejects(() => harness.call("job_clear", { taskId: running.id }), /cannot clear running job/);
	const runningOutput = internalOutputPath(root, running.id);
	const completedOutput = internalOutputPath(root, completed.id);
	await readFile(runningOutput);
	await readFile(join(root, SESSION, `${running.id}.json`));

	const single = await harness.call("job_clear", { taskId: completed.id });
	assert.equal(single.details.count, 1);
	assert.equal(single.details.cleared, undefined);
	assert.deepEqual(single.content, [{ type: "text", text: "Finished job cleared." }]);
	await assert.rejects(() => readFile(completedOutput), /ENOENT/);
	await assert.rejects(() => readFile(join(root, SESSION, `${completed.id}.json`)), /ENOENT/);
	await readFile(runningOutput);

	const bulk = await harness.call("job_clear", { allFinished: true });
	assert.equal(bulk.details.count, 1);
	assert.deepEqual(bulk.details.cleared, [failed.id]);
	const remaining = (await harness.call("job_status", {})).details.tasks as JobTask[];
	assert.deepEqual(remaining.map((task) => task.id), [running.id]);
	assert.equal(remaining[0]?.status, "running");
	await readFile(runningOutput);

	const killed = await harness.call("job_kill", { taskId: running.id });
	assert.equal(killed.details.id, undefined);
	assert.equal(killed.details.status, "killed");
	assert.equal(killed.details.output_path, undefined);
	assert.equal(killed.details.command, undefined);
});
