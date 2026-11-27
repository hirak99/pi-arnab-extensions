import assert from "node:assert/strict";
import test from "node:test";

import { colorStatus } from "../src/status-color.ts";

const highlights = [
	{ text: "1 paused", tone: "warning" as const },
	{ text: "1 broken", tone: "error" as const },
];

test("watcher status honors NO_COLOR with identical spacing", () => {
	assert.equal(
		colorStatus("👀 0/2 watchers active · 1 paused · 1 broken", "standard", { NO_COLOR: "" }, highlights),
		" 👀 0/2 watchers active · 1 paused · 1 broken ",
	);
});

test("active watcher background spans the full item and survives foreground suffixes", () => {
	const status = colorStatus("👀 1/2 watchers active · 1 paused · 1 broken", "info", {}, highlights);
	assert.match(status, /^\x1b\[48;2;183;223;255m/);
	assert.match(status, /1 paused\x1b\[48;2;183;223;255m/);
	assert.match(status, /1 broken\x1b\[48;2;183;223;255m/);
	assert.match(status, / \x1b\[0m$/);
});

test("inactive watcher status has no background and colors only persistent suffixes", () => {
	const status = colorStatus("👀 0/2 watchers active · 1 paused · 1 broken", "standard", {}, highlights);
	assert.match(status, /^ 👀 0\/2 watchers active/);
	assert.doesNotMatch(status, /\x1b\[48;/);
	assert.match(status, /\x1b\[38;2;150;95;0m1 paused\x1b\[0m/);
	assert.match(status, /\x1b\[38;2;180;25;25m1 broken\x1b\[0m/);
});
