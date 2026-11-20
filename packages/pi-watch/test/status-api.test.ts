import assert from "node:assert/strict";
import test from "node:test";

import {
	WATCH_REQUEST_CHANNEL,
	WATCH_REQUEST_SCHEMA,
	WATCH_RESPONSE_CHANNEL,
	registerWatchStatusApi,
	type WatchStatusEntry,
} from "../src/status-api.ts";
import { initialRuntimeState, type WatchMode, type WatchStatus } from "../src/types.ts";

function eventBus() {
	const handlers = new Map<string, Set<(event: any) => void>>();
	return {
		on(name: string, handler: (event: any) => void) {
			const existing = handlers.get(name) ?? new Set();
			existing.add(handler);
			handlers.set(name, existing);
			return () => existing.delete(handler);
		},
		emit(name: string, event: any) {
			for (const handler of handlers.get(name) ?? []) handler(event);
		},
	};
}

function entry(id: string, mode: WatchMode, status: WatchStatus, broken = false): WatchStatusEntry {
	return {
		definition: {
			id,
			name: `Watch ${id}`,
			mode,
			run: "not exposed by the status API",
			...(mode === "poll" ? { every_seconds: 60 } : {}),
			timeout_seconds: 120,
			session_id: "session-test",
			created_at: "2026-11-20T00:00:00.000Z",
		},
		state: {
			...initialRuntimeState(status),
			broken,
			restart_attempt: broken ? 2 : 0,
		},
	};
}

test("status API returns every watch without commands or logs and unsubscribes cleanly", () => {
	const bus = eventBus();
	const responses: any[] = [];
	bus.on(WATCH_RESPONSE_CHANNEL, (event) => responses.push(event));
	const unsubscribe = registerWatchStatusApi({ events: bus } as any, () => [
		entry("running", "poll", "running"),
		entry("paused", "stream", "paused"),
		entry("stopped", "poll", "stopped"),
		entry("broken", "stream", "running", true),
	]);

	bus.emit(WATCH_REQUEST_CHANNEL, {
		schema_version: WATCH_REQUEST_SCHEMA,
		request_id: "ignored",
		operation: "other",
	});
	assert.equal(responses.length, 0);

	bus.emit(WATCH_REQUEST_CHANNEL, {
		schema_version: WATCH_REQUEST_SCHEMA,
		request_id: "request-1",
		operation: "status",
		payload: {},
	});
	assert.equal(responses.length, 1);
	assert.equal(responses[0].ok, true);
	assert.equal(responses[0].request_id, "request-1");
	assert.deepEqual(responses[0].result.watches, [
		{ name: "Watch running", id: "running", mode: "poll", status: "running", every_seconds: 60, broken: false, restart_attempt: 0 },
		{ name: "Watch paused", id: "paused", mode: "stream", status: "paused", every_seconds: null, broken: false, restart_attempt: 0 },
		{ name: "Watch stopped", id: "stopped", mode: "poll", status: "stopped", every_seconds: 60, broken: false, restart_attempt: 0 },
		{ name: "Watch broken", id: "broken", mode: "stream", status: "running", every_seconds: null, broken: true, restart_attempt: 2 },
	]);
	assert.equal(JSON.stringify(responses[0]).includes("not exposed"), false);

	unsubscribe();
	bus.emit(WATCH_REQUEST_CHANNEL, {
		schema_version: WATCH_REQUEST_SCHEMA,
		request_id: "request-2",
		operation: "status",
	});
	assert.equal(responses.length, 1);
});

test("status API reports provider failures instead of throwing into the EventBus", () => {
	const bus = eventBus();
	const responses: any[] = [];
	bus.on(WATCH_RESPONSE_CHANNEL, (event) => responses.push(event));
	registerWatchStatusApi({ events: bus } as any, () => {
		throw new Error("registry unavailable");
	});

	bus.emit(WATCH_REQUEST_CHANNEL, {
		schema_version: WATCH_REQUEST_SCHEMA,
		request_id: "request-error",
		operation: "status",
	});
	assert.equal(responses.length, 1);
	assert.equal(responses[0].ok, false);
	assert.equal(responses[0].error, "registry unavailable");
});
