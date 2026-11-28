import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { formatJobsStatus, jobNotificationText } from "../src/format.ts";
import { JobSupervisor } from "../src/supervisor.ts";
import type { JobTask } from "../src/types.ts";

async function fixture(t: test.TestContext, sessionId = "job-test-session", maxSegmentBytes?: number) {
	const root = await mkdtemp(join(tmpdir(), "pi-background-jobs-"));
	const delivered: JobTask[] = [];
	const errors: Error[] = [];
	const deliver = (task: JobTask) => { delivered.push(task); };
	const onError = (error: Error) => { errors.push(error); };
	const supervisor = new JobSupervisor(root, deliver, () => {}, onError, 25, join(root, "output"), maxSegmentBytes);
	await supervisor.restore(sessionId);
	t.after(async () => {
		await supervisor.shutdown();
		await rm(root, { recursive: true, force: true });
	});
	return { root, supervisor, delivered, errors, deliver, onError, sessionId };
}

test("successful jobs flush output before publishing completion", async (t) => {
	const { supervisor, delivered, errors, sessionId } = await fixture(t);
	const started = await supervisor.start(sessionId, {
		name: "Successful job",
		command: "printf 'stdout line\\n'; printf 'stderr line\\n' >&2",
		cwd: "/tmp",
	});
	await supervisor.resolve(started.id, sessionId).done;
	assert.equal(delivered.length, 1);
	assert.equal(delivered[0]?.status, "completed");
	assert.equal(delivered[0]?.exit_code, 0);
	assert.match(await readFile(started.output_path, "utf8"), /stdout line\nstderr line\n/);
	assert.match(jobNotificationText(delivered[0]!), /completed successfully/);
	assert.deepEqual(errors, []);
});

test("nonzero exits and timeouts fail with durable metadata", async (t) => {
	const { supervisor, delivered, sessionId } = await fixture(t);
	const failed = await supervisor.start(sessionId, { name: "Failure", command: "printf nope; exit 7", cwd: "/tmp" });
	await supervisor.resolve(failed.id, sessionId).done;
	assert.equal(delivered.at(-1)?.status, "failed");
	assert.equal(delivered.at(-1)?.exit_code, 7);

	const timed = await supervisor.start(sessionId, {
		name: "Timeout",
		command: "sleep 60",
		cwd: "/tmp",
		timeoutSeconds: 1,
	});
	const originalDeadline = timed.deadline_at;
	await supervisor.resolve(timed.id, sessionId).done;
	const terminal = supervisor.resolve(timed.id, sessionId).task;
	assert.equal(terminal.status, "failed");
	assert.match(terminal.error ?? "", /Timed out after 1 seconds/);
	assert.equal(originalDeadline, timed.deadline_at);
	assert.equal(terminal.deadline_at, null);
});

test("reload detachment preserves the process and defers completion exactly once", async (t) => {
	const { supervisor, delivered, deliver, onError, sessionId } = await fixture(t);
	const started = await supervisor.start(sessionId, {
		name: "Reload job",
		command: "printf 'started\\n'; sleep 0.2; printf 'finished\\n'",
		cwd: "/tmp",
	});
	supervisor.detach();
	const pid = started.pid;
	await delay(350);
	assert.equal(delivered.length, 0, "disposed extension must not receive completion");
	assert.equal(supervisor.resolve(started.id, sessionId).task.status, "completed");
	supervisor.rebind(deliver, () => {}, onError);
	assert.equal(delivered.length, 1);
	supervisor.rebind(deliver, () => {}, onError);
	assert.equal(delivered.length, 1, "rebinding must not replay delivered notifications");
	assert.match(await readFile(started.output_path, "utf8"), /started\nfinished\n/);
	assert.ok(pid && pid > 0);
});

test("reload rebind waits for log and durable metadata finalization", async (t) => {
	const { supervisor, delivered, deliver, onError, sessionId } = await fixture(t);
	const store = (supervisor as any).store;
	const originalSave = store.save.bind(store);
	let terminalSaveStarted!: () => void;
	const saveStarted = new Promise<void>((resolve) => { terminalSaveStarted = resolve; });
	let releaseTerminalSave!: () => void;
	const saveGate = new Promise<void>((resolve) => { releaseTerminalSave = resolve; });
	store.save = async (task: JobTask) => {
		if (task.status === "completed") {
			terminalSaveStarted();
			await saveGate;
		}
		await originalSave(task);
	};
	const started = await supervisor.start(sessionId, {
		name: "Finalization barrier",
		command: "printf 'complete output\\n'",
		cwd: "/tmp",
	});
	supervisor.detach();
	await saveStarted;
	supervisor.rebind(deliver, () => {}, onError);
	assert.equal(delivered.length, 0, "finished is not publishable until finalization completes");
	releaseTerminalSave();
	await supervisor.resolve(started.id, sessionId).done;
	assert.equal(delivered.length, 1);
	assert.match(await readFile(started.output_path, "utf8"), /complete output/);
	supervisor.rebind(deliver, () => {}, onError);
	assert.equal(delivered.length, 1);
});

test("terminal metadata is still saved after output close failure", async (t) => {
	const { supervisor, delivered, errors, sessionId } = await fixture(t);
	const started = await supervisor.start(sessionId, {
		name: "Close failure",
		command: "sleep 0.1; printf complete",
		cwd: "/tmp",
	});
	const entry = supervisor.resolve(started.id, sessionId);
	const close = entry.log!.close.bind(entry.log);
	entry.log!.close = async () => {
		await close();
		throw new Error("injected close failure");
	};
	await entry.done;
	const store = (supervisor as any).store;
	assert.equal((await store.readMetadata(started.id)).status, "completed");
	assert.equal(delivered[0]?.status, "completed");
	assert.ok(errors.some((error) => error.message.includes("injected close failure")));
});

test("terminal metadata is still saved after an earlier PID save failure", async (t) => {
	const { supervisor, delivered, sessionId } = await fixture(t);
	const store = (supervisor as any).store;
	const save = store.save.bind(store);
	let failPidSave = true;
	store.save = async (task: JobTask) => {
		if (failPidSave && task.status === "running" && task.pid !== null) {
			failPidSave = false;
			throw new Error("injected PID save failure");
		}
		await save(task);
	};
	const started = await supervisor.start(sessionId, { name: "Save failure", command: "printf complete", cwd: "/tmp" });
	await supervisor.resolve(started.id, sessionId).done;
	assert.equal((await store.readMetadata(started.id)).status, "completed");
	assert.equal(delivered[0]?.status, "completed");
});

test("job kill terminates the POSIX process group and preserves logs", async (t) => {
	if (process.platform === "win32") return;
	const { supervisor, delivered, sessionId } = await fixture(t);
	const started = await supervisor.start(sessionId, {
		name: "Process tree",
		command: "sleep 60 & child=$!; echo $child; wait",
		cwd: "/tmp",
	});
	let childPid = 0;
	for (let attempt = 0; attempt < 100; attempt++) {
		const text = await readFile(started.output_path, "utf8").catch(() => "");
		childPid = Number(text.trim());
		if (childPid > 0) break;
		await delay(10);
	}
	assert.ok(childPid > 0, "child PID was written");
	const killed = await supervisor.kill(started.id, sessionId);
	assert.equal(killed.status, "killed");
	assert.equal(delivered.at(-1)?.status, "killed");
	assert.throws(() => process.kill(childPid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH");
});

test("full shutdown kills jobs and cold restore retains history without relaunching", async (t) => {
	const { root, supervisor, delivered, sessionId } = await fixture(t);
	const started = await supervisor.start(sessionId, { name: "Shutdown job", command: "sleep 60", cwd: "/tmp" });
	await supervisor.shutdown();
	assert.equal(supervisor.resolve(started.id, sessionId).task.status, "killed");
	assert.equal(delivered.length, 0, "shutdown does not wake a disposed session");

	const restoredDelivered: JobTask[] = [];
	const restored = new JobSupervisor(root, (task) => restoredDelivered.push(task), undefined, undefined, 2_000, join(root, "output"));
	await restored.restore(sessionId);
	t.after(() => restored.shutdown());
	assert.equal(restored.resolve(started.id, sessionId).task.status, "killed");
	assert.equal(restored.resolve(started.id, sessionId).task.pid, null);
	assert.equal(restoredDelivered.length, 0);
});

test("session isolation and bounded log reads are enforced", async (t) => {
	const { root, supervisor, sessionId } = await fixture(t);
	const other = new JobSupervisor(root, undefined, undefined, undefined, 2_000, join(root, "output"));
	await other.restore("other-session");
	t.after(() => other.shutdown());
	const started = await supervisor.start(sessionId, {
		name: "Log job",
		command: "printf 0123456789",
		cwd: "/tmp",
	});
	await supervisor.resolve(started.id, sessionId).done;
	assert.equal(other.list("other-session").length, 0);
	assert.throws(() => other.resolve(started.id, "other-session"), /job not found/);

	const tail = await supervisor.readLogs(started.id, sessionId, true, 4);
	assert.equal(tail.text, "6789");
	assert.equal(tail.truncated, true);
	const head = await supervisor.readLogs(started.id, sessionId, false, 4);
	assert.equal(head.text, "0123");
	assert.equal(head.omitted_lines, undefined);
	await rm(started.output_path, { force: true });
	const missing = await supervisor.readLogs(started.id, sessionId, true, 4);
	assert.equal(missing.text, "");
	assert.equal(missing.truncated, false);
	await assert.rejects(() => supervisor.readLogs(started.id, sessionId, true, 50_001), /maxBytes/);
});

test("running-job export is a point-in-time snapshot and can be refreshed", async (t) => {
	const { root, supervisor, sessionId } = await fixture(t);
	const started = await supervisor.start(sessionId, {
		name: "Running export",
		command: "printf before; sleep 0.2; printf after",
		cwd: "/tmp",
	});
	for (let attempt = 0; attempt < 100; attempt++) {
		if ((await readFile(started.output_path, "utf8").catch(() => "")).includes("before")) break;
		await delay(10);
	}
	const destination = join(root, "saved", "running.log");
	const snapshot = await supervisor.exportOutput(started.id, sessionId, destination, false);
	assert.deepEqual(snapshot, { bytes_written: 6 });
	assert.equal(await readFile(destination, "utf8"), "before");
	assert.equal(supervisor.resolve(started.id, sessionId).task.status, "running");
	await supervisor.resolve(started.id, sessionId).done;
	const final = await supervisor.exportOutput(started.id, sessionId, destination, true);
	assert.deepEqual(final, { bytes_written: 11 });
	assert.equal(await readFile(destination, "utf8"), "beforeafter");
});

test("job output rotates without failing and clear removes every segment", async (t) => {
	const { root, supervisor, delivered, sessionId } = await fixture(t, "job-rotation-session", 16);
	const started = await supervisor.start(sessionId, {
		name: "Bounded output",
		command: "for i in $(seq 1 20); do printf '%s\\n' \"$i\"; done",
		cwd: "/tmp",
	});
	await supervisor.resolve(started.id, sessionId).done;
	assert.equal(delivered[0]?.status, "completed");
	assert.ok((await stat(started.output_path)).size <= 16);
	assert.ok((await stat(`${started.output_path}.1`)).size <= 16);
	const logs = await supervisor.readLogs(started.id, sessionId, true);
	assert.ok((logs.omitted_lines ?? 0) > 0);
	assert.doesNotMatch(logs.text, /(?:^|\n)1\n/);
	const destination = join(root, "exports", "retained.log");
	const exported = await supervisor.exportOutput(started.id, sessionId, destination, false);
	assert.equal(exported.omitted_lines, logs.omitted_lines);
	assert.equal(exported.bytes_written, Buffer.byteLength(await readFile(destination, "utf8")));
	assert.equal(
		await readFile(destination, "utf8"),
		await readFile(`${started.output_path}.1`, "utf8") + await readFile(started.output_path, "utf8"),
	);
	await supervisor.clear(started.id, sessionId);
	await stat(destination);
	for (const path of [started.output_path, `${started.output_path}.1`, `${started.output_path}.state.json`]) {
		await assert.rejects(() => stat(path), { code: "ENOENT" });
	}
});

test("clearFinished permanently removes terminal records and leaves running jobs untouched", async (t) => {
	const { root, supervisor, sessionId } = await fixture(t);
	const completed = await supervisor.start(sessionId, { name: "Done", command: "printf done", cwd: "/tmp" });
	const failed = await supervisor.start(sessionId, { name: "Failed", command: "exit 9", cwd: "/tmp" });
	const killedStart = await supervisor.start(sessionId, { name: "Stopped", command: "sleep 60", cwd: "/tmp" });
	const running = await supervisor.start(sessionId, { name: "Still running", command: "sleep 60", cwd: "/tmp" });
	await supervisor.resolve(completed.id, sessionId).done;
	await supervisor.resolve(failed.id, sessionId).done;
	await supervisor.kill(killedStart.id, sessionId);

	const cleared = await supervisor.clearFinished(sessionId);
	assert.equal(cleared.length, 3);
	assert.deepEqual(new Set(cleared), new Set([completed.id, failed.id, killedStart.id]));
	assert.deepEqual(supervisor.list(sessionId).map((task) => task.id), [running.id]);
	for (const task of [completed, failed, killedStart]) {
		await assert.rejects(() => stat(task.output_path), /ENOENT/);
		await assert.rejects(() => stat(join(root, sessionId, `${task.id}.json`)), /ENOENT/);
	}
	await stat(running.output_path);
	await stat(join(root, sessionId, `${running.id}.json`));
	assert.equal(supervisor.resolve(running.id, sessionId).task.status, "running");
	assert.equal((await supervisor.clearFinished(sessionId)).length, 0);
});

test("footer status distinguishes running jobs and aggregates unseen finished jobs", async () => {
	const base: JobTask = {
		id: "job", session_id: "session", name: "Job", command: "true", pid: null,
		output_path: "/tmp/job.output", created_at: new Date().toISOString(), completed_at: null,
		exit_code: null, signal: null, error: null, timeout_seconds: null, deadline_at: null,
		status: "running",
	};
	assert.equal(formatJobsStatus([], []), undefined);
	assert.equal(formatJobsStatus([base], []), "🧵 1 job running · /jobs");
	assert.equal(
		formatJobsStatus([base, { ...base, id: "job-2" }], []),
		"🧵 2 jobs running · /jobs",
	);
	assert.equal(
		formatJobsStatus([{ ...base, status: "completed" }], [{ ...base, status: "completed" }]),
		"🧵 1 finished · /jobs",
	);
	assert.equal(
		formatJobsStatus([base], [
			{ ...base, status: "failed" },
			{ ...base, status: "completed" },
			{ ...base, status: "killed" },
		]),
		"🧵 1 of 4 jobs running · /jobs",
	);
});
