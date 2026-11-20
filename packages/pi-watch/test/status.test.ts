import assert from "node:assert/strict";
import test from "node:test";

import { formatWatcherStatus } from "../src/status.ts";
import { initialRuntimeState, type WatchRuntimeState } from "../src/types.ts";

function watch(status: WatchRuntimeState["status"], broken = false) {
	return { state: { ...initialRuntimeState(status), broken } };
}

test("watcher footer is hidden when the session has no watches", () => {
	assert.equal(formatWatcherStatus([]), undefined);
});

test("watcher footer shows active and total counts without a zero broken suffix", () => {
	assert.equal(formatWatcherStatus([watch("running"), watch("running")]), "👀 2/2 watchers active");
	assert.equal(
		formatWatcherStatus([watch("running"), watch("paused"), watch("stopped")]),
		"👀 1/3 watchers active",
	);
});

test("watcher footer shows broken count only when non-zero", () => {
	assert.equal(
		formatWatcherStatus([
			watch("running"),
			watch("running"),
			watch("running", true),
			watch("paused"),
			watch("stopped"),
		]),
		"👀 3/5 watchers active · 1 broken",
	);
});

test("watcher footer uses singular wording for one watch", () => {
	assert.equal(formatWatcherStatus([watch("paused")]), "👀 0/1 watcher active");
});
