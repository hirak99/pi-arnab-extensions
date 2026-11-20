import assert from "node:assert/strict";
import test from "node:test";

import { TEAM_COMMANDS } from "../src/commands.ts";

test("every human-facing team command uses the team- prefix", () => {
	for (const command of Object.values(TEAM_COMMANDS)) {
		assert.match(command, /^team-/);
	}
});

test("command names are stable and grouped", () => {
	assert.equal(TEAM_COMMANDS.register, "team-agent-register");
	assert.equal(TEAM_COMMANDS.responsibilities, "team-agent-responsibilities");
});
