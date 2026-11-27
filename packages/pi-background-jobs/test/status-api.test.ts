import assert from "node:assert/strict";
import test from "node:test";

import {
	JOB_REQUEST_CHANNEL,
	JOB_REQUEST_SCHEMA,
	JOB_RESPONSE_CHANNEL,
	JOB_RESPONSE_SCHEMA,
	registerJobStatusApi,
} from "../src/status-api.ts";

test("job status API is display-only, session-filtered by its provider, and handles failures", () => {
	const handlers = new Map<string, (event: unknown) => void>();
	const emitted: Array<{ channel: string; event: any }> = [];
	const pi = {
		events: {
			on(channel: string, handler: (event: unknown) => void) {
				handlers.set(channel, handler);
				return () => handlers.delete(channel);
			},
			emit(channel: string, event: unknown) { emitted.push({ channel, event }); },
		},
	};
	let error: Error | undefined;
	const unsubscribe = registerJobStatusApi(pi as any, () => {
		if (error) throw error;
		return [{ id: "job-a", name: "Build", status: "running" } as any];
	});
	const handler = handlers.get(JOB_REQUEST_CHANNEL)!;
	handler({ schema_version: "wrong", operation: "status", request_id: "ignored" });
	assert.equal(emitted.length, 0);
	handler({ schema_version: JOB_REQUEST_SCHEMA, operation: "status", request_id: "request-a" });
	assert.equal(emitted[0]?.channel, JOB_RESPONSE_CHANNEL);
	assert.deepEqual(emitted[0]?.event, {
		schema_version: JOB_RESPONSE_SCHEMA,
		request_id: "request-a",
		operation: "status",
		ok: true,
		result: { tasks: [{ id: "job-a", name: "Build", status: "running" }] },
	});

	error = new Error("status failed");
	handler({ schema_version: JOB_REQUEST_SCHEMA, operation: "status", request_id: "request-b" });
	assert.equal(emitted[1]?.event.ok, false);
	assert.equal(emitted[1]?.event.error, "status failed");
	unsubscribe();
	assert.equal(handlers.size, 0);
});
