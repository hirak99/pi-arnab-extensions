import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { WatchRegistry } from "../src/registry.ts";
import { formatWatcherStatus } from "../src/status.ts";
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
	assert.equal(silent.supervisor.get("quiet-exit", SESSION).state.status, "stopped");

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
	assert.equal(supervisor.get("restart", SESSION).state.broken, false, "restart clears broken state immediately");
	await waitFor(() => events.some((event) => event.includes("finished")), "clean finish after restart");
	const { state } = supervisor.get("restart", SESSION);
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

test("poll: max_events=1 delivers one alert and automatically removes the watch", async (t) => {
	const { supervisor, events, root } = await withSupervisor(t);
	const definition = await supervisor.create({
		name: "once-poll",
		mode: "poll",
		run: "echo only-once; exit 1",
		everySeconds: 1,
		maxEvents: 1,
		sessionId: SESSION,
	});
	await waitFor(() => events.length >= 1, "one-shot poll event");
	await waitFor(() => supervisor.getById(definition.id) === undefined, "automatic removal");
	const registry = new WatchRegistry(root);
	await waitFor(async () => (await registry.readLogTail(definition.id, 50)).some((line) => line.includes("watch removed")), "removal log");
	await delay(1200);
	assert.equal(events.length, 1);
	assert.match(events[0]!, /only-once/);
	assert.match(events[0]!, /max_events=1 reached; watch stopped and removed/);
	assert.throws(() => supervisor.get("once-poll", SESSION), WatchError);
	await assert.rejects(() => supervisor.resume("once-poll", SESSION), /no watch named/);
	assert.equal(await registry.loadState(definition.id), undefined);
	assert.deepEqual(await registry.listDefinitions(), []);
});

test("stream: max_events=1 delivers only the first match and suppresses on_finish", async (t) => {
	const { supervisor, events } = await withSupervisor(t);
	const definition = await supervisor.create({
		name: "once-stream",
		mode: "stream",
		run: "echo first; echo second; exit 0",
		maxEvents: 1,
		onFinish: true,
		sessionId: SESSION,
	});
	await waitFor(() => events.length >= 1, "one-shot stream event");
	await waitFor(() => supervisor.getById(definition.id) === undefined, "automatic removal");
	await delay(100);
	assert.equal(events.length, 1);
	assert.match(events[0]!, /first/);
	assert.match(events[0]!, /watch stopped and removed/);
	assert.doesNotMatch(events[0]!, /second|finished/);
	assert.throws(() => supervisor.get("once-stream", SESSION), WatchError);
});

test("stream: capped truncated output does not point at removed watch_tail state", async (t) => {
	const { supervisor, events } = await withSupervisor(t);
	const definition = await supervisor.create({
		name: "once-large",
		mode: "stream",
		run: "printf '%2100s' x | tr ' ' x",
		maxEvents: 1,
		sessionId: SESSION,
	});
	await waitFor(() => events.length >= 1, "truncated one-shot event");
	await waitFor(() => supervisor.getById(definition.id) === undefined, "automatic removal");
	assert.match(events[0]!, /… \(truncated\)/);
	assert.match(events[0]!, /watch stopped and removed/);
	assert.doesNotMatch(events[0]!, /watch_tail/);
});

test("stream: max_events counts source events and flushes a coalesced final batch", async (t) => {
	const { supervisor, events } = await withSupervisor(t, { eventRateFloorMs: 60_000 });
	const definition = await supervisor.create({
		name: "finite-burst",
		mode: "stream",
		run: "for i in 1 2 3 4; do echo \"event $i\"; done; sleep 1",
		maxEvents: 3,
		sessionId: SESSION,
	});
	await waitFor(() => events.length >= 1, "final coalesced event");
	await waitFor(() => supervisor.getById(definition.id) === undefined, "automatic removal");
	assert.equal(events.length, 1);
	assert.match(events[0]!, /3 events \(rate-limited\)/);
	assert.match(events[0]!, /events #1–3/);
	assert.match(events[0]!, /max_events=3 reached; watch stopped and removed/);
	assert.doesNotMatch(events[0]!, /event 4|watch_tail/);
});

test("watch lifecycle: pause stops events, resume restarts, remove deletes definition", async (t) => {
	const { supervisor, events, root } = await withSupervisor(t);
	const marker = join(await mkdtemp(join(tmpdir(), "pi-watch-marker-")), "count");
	const shell = (exit: string) => `n=$(cat ${marker} 2>/dev/null || echo 0); echo $((n+1)) > ${marker}; echo "seen $n"; exit ${exit}`;
	await supervisor.create({ name: "life", mode: "poll", run: shell("1"), everySeconds: 1, sessionId: SESSION });
	await waitFor(() => events.length >= 1, "first event");
	await supervisor.pause("life", SESSION);
	const pausedAt = events.length;
	await delay(1300);
	assert.equal(events.length, pausedAt, "paused watch produces no events");

	await supervisor.resume("life", SESSION);
	await waitFor(() => events.length > pausedAt, "event after resume");

	await supervisor.remove("life", SESSION);
	assert.throws(() => supervisor.get("life", SESSION), WatchError);
	const registry = new WatchRegistry(root);
	assert.deepEqual(await registry.listDefinitions(), []);
});

test("session scope isolates listing and lifecycle operations while allowing reused names", async (t) => {
	const { supervisor } = await withSupervisor(t);
	const otherSession = "session-test-2";
	const first = await supervisor.create({
		name: "shared-name",
		mode: "poll",
		run: "exit 0",
		everySeconds: 3600,
		sessionId: SESSION,
	});
	const second = await supervisor.create({
		name: "shared-name",
		mode: "poll",
		run: "exit 0",
		everySeconds: 3600,
		sessionId: otherSession,
	});

	assert.deepEqual(supervisor.list(SESSION).map(({ definition }) => definition.id), [first.id]);
	assert.deepEqual(supervisor.list(otherSession).map(({ definition }) => definition.id), [second.id]);
	assert.equal(supervisor.get("shared-name", SESSION).definition.id, first.id);
	assert.equal(supervisor.get("shared-name", otherSession).definition.id, second.id);
	assert.throws(() => supervisor.get("shared-name", "unknown-session"), WatchError);

	await supervisor.pause("shared-name", SESSION);
	assert.equal(supervisor.get("shared-name", SESSION).state.status, "paused");
	assert.equal(supervisor.get("shared-name", otherSession).state.status, "running");
	await supervisor.resume("shared-name", SESSION);
	assert.equal(supervisor.get("shared-name", SESSION).state.status, "running");

	await supervisor.remove("shared-name", SESSION);
	assert.throws(() => supervisor.get("shared-name", SESSION), WatchError);
	assert.equal(supervisor.get("shared-name", otherSession).definition.id, second.id);
	await assert.rejects(() => supervisor.pause("shared-name", SESSION), WatchError);
	await assert.rejects(() => supervisor.tail("shared-name", SESSION, 50), WatchError);
});

test("status hook reflects create, pause, resume, and removal", async (t) => {
	let fixture: Fixture | undefined;
	const statuses: Array<string | undefined> = [];
	fixture = await withSupervisor(t, {
		onStateChange: () => {
			if (fixture) statuses.push(formatWatcherStatus(fixture.supervisor.list(SESSION)));
		},
	});
	await fixture.supervisor.create({
		name: "status",
		mode: "poll",
		run: "exit 0",
		everySeconds: 3600,
		sessionId: SESSION,
	});
	assert.equal(statuses.at(-1), "👀 1/1 watcher active");

	await fixture.supervisor.pause("status", SESSION);
	assert.equal(statuses.at(-1), "👀 0/1 watcher active");
	await fixture.supervisor.resume("status", SESSION);
	assert.equal(statuses.at(-1), "👀 1/1 watcher active");
	await fixture.supervisor.remove("status", SESSION);
	assert.equal(statuses.at(-1), undefined);
});

test("watch_tail log captures [stdout]/[stderr] lines and status trailer input", async (t) => {
	const { supervisor } = await withSupervisor(t);
	await supervisor.create({
		name: "logged",
		mode: "stream",
		run: "echo out-line; echo err-line >&2; sleep 0.2; exit 3",
		sessionId: SESSION,
	});
	await waitFor(async () => (await supervisor.tail("logged", SESSION, 50)).some((line) => line.includes("code 3")), "exit logged");
	const lines = await supervisor.tail("logged", SESSION, 50);
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
	const { state } = supervisor.get("delayed", SESSION);
	assert.equal(state.event_count >= 2, true);
	assert.notEqual(state.last_fired_at, null);
});

test("creation validates names, intervals, and match regex", async (t) => {
	const { supervisor } = await withSupervisor(t);
	await supervisor.create({ name: "dup", mode: "poll", run: "true", everySeconds: 1, sessionId: SESSION });
	await assert.rejects(() => supervisor.create({ name: "dup", mode: "poll", run: "true", everySeconds: 1, sessionId: SESSION }), /already exists/);
	await assert.rejects(() => supervisor.create({ name: "bad-interval", mode: "poll", run: "true", everySeconds: 0, sessionId: SESSION }), /every_seconds/);
	await assert.rejects(() => supervisor.create({ name: "bad-regex", mode: "stream", run: "true", match: "(", sessionId: SESSION }), /not a valid regular expression/);
	await assert.rejects(() => supervisor.create({ name: "bad-max", mode: "poll", run: "true", maxEvents: 0, sessionId: SESSION }), /max_events/);
	await assert.rejects(() => supervisor.create({ name: "fractional-max", mode: "stream", run: "true", maxEvents: 1.5, sessionId: SESSION }), /max_events/);
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
