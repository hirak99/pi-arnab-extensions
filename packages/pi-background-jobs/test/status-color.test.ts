import assert from "node:assert/strict";
import test from "node:test";

import { colorStatus } from "../src/status-color.ts";

test("status colors use soft semantic pills and honor NO_COLOR", () => {
	assert.equal(colorStatus("plain", "error", { NO_COLOR: "1" }), " plain ");
	const info = colorStatus("running", "info", {});
	const error = colorStatus("failed", "error", {});
	assert.match(info, /^\x1b\[48;2;183;223;255m/);
	assert.match(error, /^\x1b\[48;2;255;190;190m/);
	assert.match(info, / running \x1b\[0m$/);
	assert.notEqual(info, error);
});
