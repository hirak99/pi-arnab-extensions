import assert from "node:assert/strict";
import test from "node:test";

import { colorStatus } from "../src/status-color.ts";

const highlights = [
	{ text: "1 paused", tone: "warning" as const },
	{ text: "1 broken", tone: "error" as const },
];

test("watcher status honors NO_COLOR with identical spacing", () => {
	assert.equal(
		colorStatus("👀 0/2 watchers active · 1 paused · 1 broken", "warning", { NO_COLOR: "" }, highlights),
		" 👀 0/2 watchers active · 1 paused · 1 broken ",
	);
});

test("all-active watcher background is blue and survives a broken suffix", () => {
	const status = colorStatus("👀 2/2 watchers active · 1 broken", "info", {}, [{ text: "1 broken", tone: "error" }]);
	assert.match(status, /^\x1b\[48;2;183;223;255m/);
	assert.match(status, /1 broken\x1b\[48;2;183;223;255m/);
	assert.match(status, / \x1b\[0m$/);
});

test("any inactive watcher selects amber across the full item", () => {
	const status = colorStatus("👀 0/2 watchers active · 1 paused · 1 broken", "warning", {}, highlights);
	assert.match(status, /^\x1b\[48;2;255;226;163m/);
	assert.match(status, /1 paused\x1b\[48;2;255;226;163m/);
	assert.match(status, /1 broken\x1b\[48;2;255;226;163m/);
	assert.match(status, / \x1b\[0m$/);
});

test("stopped-only watchers are amber even without a suffix", () => {
	const status = colorStatus("👀 0/2 watchers active", "warning", {});
	assert.match(status, /^\x1b\[48;2;255;226;163m/);
	assert.match(status, /^[\s\S]* 👀 0\/2 watchers active \x1b\[0m$/);
});
