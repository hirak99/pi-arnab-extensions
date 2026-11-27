import assert from "node:assert/strict";
import test from "node:test";

import { colorStatus } from "../src/status-color.ts";

test("watcher status colors honor NO_COLOR and reset terminal styling", () => {
	assert.equal(colorStatus("👀 0/1 watchers active", "warning", { NO_COLOR: "" }), "👀 0/1 watchers active");
	assert.match(colorStatus("👀 1/1 watcher active", "info", {}), /^\x1b\[48;2;183;223;255m/);
	assert.match(colorStatus("👀 1/1 watcher active · 1 broken", "error", {}), /1 broken\x1b\[0m$/);
});
