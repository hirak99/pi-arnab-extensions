import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TeamStore } from "../src/store.ts";

test("team membership is optional, normalized, preserved, and replaceable", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-team-membership-"));
	const store = new TeamStore(root);
	const input = {
		duties: "Test membership",
		sessionId: "membership-test",
		cwd: root,
		pid: process.pid,
		transport: { type: "none" as const },
	};
	t.after(() => rm(root, { recursive: true, force: true }));

	const unassigned = await store.register(input);
	assert.deepEqual(unassigned.teams, [], "agents need not join any team");

	const member = await store.register({ ...input, name: "Member", teams: ["ops", "dev", "dev"] }, unassigned.agent_id);
	assert.deepEqual(member.teams, ["dev", "ops"], "membership is deduplicated and sorted");
	assert.deepEqual((await store.getAgent(member.agent_id)).teams, ["dev", "ops"]);

	const preserved = await store.register({ ...input, name: "Renamed" }, member.agent_id);
	assert.deepEqual(preserved.teams, ["dev", "ops"], "omitting teams preserves membership");

	const cleared = await store.register({ ...input, teams: [] }, member.agent_id);
	assert.deepEqual(cleared.teams, [], "explicit empty list clears membership");
	assert.equal(cleared.agent_id, unassigned.agent_id, "membership changes preserve agent identity");

	await assert.rejects(
		() => store.register({ ...input, teams: ["not a team slug"] }, member.agent_id),
		/team names must match/,
	);
});
