import assert from "node:assert/strict";
import test from "node:test";

import { colorStatus } from "../src/status-color.ts";

test("job status uses a full blue pill only while running", () => {
	assert.equal(colorStatus("🧵 1 finished · /jobs", "standard", {}), " 🧵 1 finished · /jobs ");
	assert.equal(colorStatus("🧵 1 finished · /jobs", "info", { NO_COLOR: "1" }), " 🧵 1 finished · /jobs ");
	const info = colorStatus("🧵 1 of 4 jobs running · /jobs", "info", {});
	assert.match(info, /^\x1b\[48;2;183;223;255m/);
	assert.match(info, /\/jobs \x1b\[0m$/);
});
