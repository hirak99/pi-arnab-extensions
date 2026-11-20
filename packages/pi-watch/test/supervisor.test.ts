import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { WatchRegistry } from "../src/registry.ts";
import { WatchError, WatchSupervisor } from "../src/supervisor.ts";
import type { WatchDefinition } from "../src/types.ts";

interface Fixture {
	supervisor: WatchSupervisor;
	events: string[];
	root: string;
}

async function withSupervisor(t: test.TestContext, options: ConstructorParameters<typeof WatchSupervisor>[2] = {}): Promise<Fixture> {
	const root = await mkdtemp(join(tmpdir(), "pi-watch-test-"));
	const registry = new WatchRegistry(root);
	const events: string[] = [];
	const supervisor = new WatchSupervisor(registry, async (_watch, body) => {
		events.push(body);
	}, { eventRateFloorMs: 0, graceMs: 30, minEverySeconds: 1, streamBackoffBaseMs: 100, streamBackoffMaxMs: 500, ...options });
	t.after(async () => {
		await supervisor.shutdown();
		await rm(root, { recursive: true, force: true });
	});
	return { supervisor, events, root };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, what: string): Promise<void> {
	const deadline = Date.now() + 3_000;
	while (!(await predicate())) {
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
		await delay(10);
	}
}

const SESSION = "session-test-1";

test("poll: exit 1 with output delivers one notification; exit 0 stays silent", async (t) => {
	const { supervisor, events } = await withSupervisor(t);
	let fired = 0;
	const marker = join(await mkdtemp(join(tmpdir(), "pi-watch-marker-")), "count");
	await supervisor.create({
		name: "poll-event",
		mode: "poll",
		run: `n=$(cat ${marker} 2>/dev/null || echo 0); echo $((n+1)) > ${marker}; [ "$n" -ge 2 ] && exit 0; echo "count is $n"; exit 1`,
		everySeconds: 1,
		sessionId: SESSION,
	});
	await waitFor(() => events.length >= 2, "two poll events");
	await delay(1200);
	assert.equal(events.length, 2, "exit 0 after two events stays silent");
	assert.match(events[0]!, /Watch "poll-event" fired:\n\ncount is 0\n\n— event #1 for this watch · \(first fire\)/);
	assert.match(events[1]!, /Watch "poll-event" fired:\n\ncount is 1\n\n— event #2 for this watch · \d+s since previous event/);
});

test("poll: bare non-zero exit (false) fires a timestamped notification", async (t) => {
	const { supervisor, events } = await withSupervisor(t);
	await supervisor.create({ name: "tick", mode: "poll", run: "false", everySeconds: 1, sessionId: SESSION });
	await waitFor(() => events.length >= 1, "periodic fire");
	assert.match(events[0]!, /^Watch "tick" fired:\n\nfired at /);
	assert.match(events[0]!, /— event #1 for this watch · \(first fire\)$/);
});

test("poll: crash notifies broke once, then recovered on next success", async (t) => {
	const { supervisor, events } = await withSupervisor(t);
	const marker = join(await mkdtemp(join(tmpdir(), "pi-watch-marker-")), "n");
	await supervisor.create({
		name: "flaky",
		mode: "poll",
		run: `n=$(cat ${marker} 2>/dev/null || echo 0); echo $((n+1)) > ${marker}; [ "$n" -eq 1 ] && exit 2; exit 0`,
		everySeconds: 1,
		sessionId: SESSION,
	});
	await waitFor(() => events.some((event) => event.includes("broke")), "broke notification");
	await waitFor(() => events.some((event) => event.includes("recovered")), "recovered notification");
	const brokeCount = events.filter((event) => event.includes("broke")).length;
	assert.equal(brokeCount, 1, "broke is reported once per breakage");
});

test("stream: every non-empty stdout line notifies; match filters; stderr never notifies", async (t) => {
	const { supervisor, events } = await withSupervisor(t);
	await supervisor.create({
		name: "lines",
		mode: "stream",
		run: "echo first; echo NOTIFY second; echo; echo third >&2; sleep 0.2",
		match: "^NOTIFY",
		sessionId: SESSION,
	});
	await waitFor(() => events.length >= 1, "stream event");
	await delay(300);
	assert.equal(events.length, 1);
	assert.match(events[0]!, /^Watch "lines" fired:\n\nNOTIFY second\n\n— event #1 for this watch · \(first fire\)$/);
});

test("stream: clean exit is silent by default; on_finish notifies once", async (t) => {
	const silent = await withSupervisor(t);
	await silent.supervisor.create({
		name: "quiet-exit",
		mode: "stream",
		run: "sleep 0.1; exit 0",
		sessionId: SESSION,
	});
	await delay(600);
	assert.deepEqual(silent.events, []);

	const finishing = await withSupervisor(t);
	await finishing.supervisor.create({
		name: "finish",
		mode: "stream",
		run: "echo done; exit 0",
		onFinish: true,
		sessionId: SESSION,
	});
	await waitFor(() => finishing.events.length >= 1, "finish notification");
	assert.match(finishing.events[0]!, /Watch "finish": script finished\./);
});

test("stream: non-zero exit notifies broke and restarts with backoff, then recovers", async (t) => {
	const { supervisor, events } = await withSupervisor(t);
	await supervisor.create({
		name: "restart",
		mode: "stream",
		run: "n=$(cat $WATCH_STATE/n 2>/dev/null || echo 0); echo $((n+1)) > $WATCH_STATE/n; sleep 0.1; [ \"$n\" -ge 1 ] && exit 0; exit 1",
		onFinish: true,
		sessionId: SESSION,
	});
	await waitFor(() => events.some((event) => event.includes("broke")), "broke");
	await waitFor(() => events.some((event) => event.includes("recovered")), "recovered after restart");
	await waitFor(() => events.some((event) => event.includes("finished")), "clean finish after restart");
	const { state } = supervisor.get("restart");
	assert.equal(state.broken, false);
});

test("rate floor coalesces: last 3 lines plus suppression trailer", async (t) => {
	const { supervisor, events } = await withSupervisor(t, { eventRateFloorMs: 60_000 });
	await supervisor.create({
		name: "burst",
		mode: "stream",
		run: "for i in 1 2 3 4 5; do echo \"event $i\"; done; sleep 0.2; exit 0",
		sessionId: SESSION,
	});
	await waitFor(() => events.length >= 1, "coalesced delivery");
	assert.equal(events.length, 1);
	assert.match(events[0]!, /5 events \(rate-limited\)/);
	assert.match(events[0]!, /\[3\] event 5/);
	assert.match(events[0]!, /2 notifications before this not shown; use watch_tail/);
	assert.match(events[0]!, /— events #1–5 for this watch · \(first fire\)$/);
});

test("watch lifecycle: pause stops events, resume restarts, remove deletes definition", async (t) => {
	const { supervisor, events, root } = await withSupervisor(t);
	const marker = join(await mkdtemp(join(tmpdir(), "pi-watch-marker-")), "count");
	const shell = (exit: string) => `n=$(cat ${marker} 2>/dev/null || echo 0); echo $((n+1)) > ${marker}; echo "seen $n"; exit ${exit}`;
	await supervisor.create({ name: "life", mode: "poll", run: shell("1"), everySeconds: 1, sessionId: SESSION });
	await waitFor(() => events.length >= 1, "first event");
	await supervisor.pause("life");
	const pausedAt = events.length;
	await delay(1300);
	assert.equal(events.length, pausedAt, "paused watch produces no events");

	await supervisor.resume("life");
	await waitFor(() => events.length > pausedAt, "event after resume");

	await supervisor.remove("life");
	assert.throws(() => supervisor.get("life"), WatchError);
	const registry = new WatchRegistry(root);
	assert.deepEqual(await registry.listDefinitions(), []);
});

test("watch_tail log captures [stdout]/[stderr] lines and status trailer input", async (t) => {
	const { supervisor } = await withSupervisor(t);
	await supervisor.create({
		name: "logged",
		mode: "stream",
		run: "echo out-line; echo err-line >&2; sleep 0.2; exit 3",
		sessionId: SESSION,
	});
	await waitFor(async () => (await supervisor.tail("logged", 50)).some((line) => line.includes("code 3")), "exit logged");
	const lines = await supervisor.tail("logged", 50);
	assert.ok(lines.some((line) => line === "[stdout]: out-line"));
	assert.ok(lines.some((line) => line === "[stderr]: err-line"));
	assert.ok(lines.some((line) => line === "[status]: script exited with code 3"));
});

test("initial_delay_seconds postpones the first run only", async (t) => {
	const { supervisor, events } = await withSupervisor(t);
	await supervisor.create({
		name: "delayed",
		mode: "poll",
		run: "echo early; exit 1",
		everySeconds: 1,
		initialDelaySeconds: 1,
		sessionId: SESSION,
	});
	await delay(400);
	assert.deepEqual(events, [], "no fire before the initial delay elapses");
	await waitFor(() => events.length >= 1, "fire after initial delay");
	assert.match(events[0]!, /early/);
	await waitFor(() => events.length >= 2, "steady cadence continues after the delay");
	assert.match(events[1]!, /— event #2 for this watch/);
	const { state } = supervisor.get("delayed");
	assert.equal(state.event_count >= 2, true);
	assert.notEqual(state.last_fired_at, null);
});

test("creation validates names, intervals, and match regex", async (t) => {
	const { supervisor } = await withSupervisor(t);
	await supervisor.create({ name: "dup", mode: "poll", run: "true", everySeconds: 1, sessionId: SESSION });
	await assert.rejects(() => supervisor.create({ name: "dup", mode: "poll", run: "true", everySeconds: 1, sessionId: SESSION }), /already exists/);
	await assert.rejects(() => supervisor.create({ name: "bad-interval", mode: "poll", run: "true", everySeconds: 0, sessionId: SESSION }), /every_seconds/);
	await assert.rejects(() => supervisor.create({ name: "bad-regex", mode: "stream", run: "true", match: "(", sessionId: SESSION }), /not a valid regular expression/);
});

test("scripts receive WATCH_STATE and per-run state survives across ticks", async (t) => {
	const { supervisor, events } = await withSupervisor(t);
	await supervisor.create({
		name: "stateful",
		mode: "poll",
		run: "n=$(cat $WATCH_STATE/n 2>/dev/null || echo 0); echo $((n+1)) > $WATCH_STATE/n; echo \"tick $n\"; exit 1",
		everySeconds: 1,
		sessionId: SESSION,
	});
	await waitFor(() => events.length >= 1, "first stateful tick");
	await waitFor(() => events.length >= 2, "second stateful tick");
	assert.match(events[0]!, /tick 0/);
	assert.match(events[1]!, /tick 1/);
});
