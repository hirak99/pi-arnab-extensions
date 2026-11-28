import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TeamStore } from "../src/store.ts";

test("team profile updates are partial, atomic, and identity-preserving", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-team-update-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const store = new TeamStore(root);
	const original = await store.register({
		duties: "Original duties",
		name: "Original name",
		teams: ["operations", "test"],
		sessionId: "update-test",
		cwd: root,
		pid: process.pid,
		transport: { type: "none" },
	});

	const membership = await store.updateAgent(original.agent_id, {
		teams: ["extensions", "operations", "extensions"],
	});
	assert.deepEqual(membership.teams, ["extensions", "operations"]);
	assert.equal(membership.name, original.name);
	assert.equal(membership.duties, original.duties);
	assert.equal(membership.agent_id, original.agent_id);
	assert.equal(membership.instance_id, original.instance_id);
	assert.equal(membership.registered_at, original.registered_at);
	assert.equal(membership.responsibilities_revision, original.responsibilities_revision);
	assert.equal(membership.responsibilities_updated_at, original.responsibilities_updated_at);

	const renamed = await store.updateAgent(original.agent_id, { name: "  Renamed agent  " });
	assert.equal(renamed.name, "Renamed agent");
	assert.deepEqual(renamed.teams, membership.teams);
	assert.equal(renamed.duties, original.duties);
	assert.equal(renamed.instance_id, original.instance_id);
	assert.equal(renamed.responsibilities_revision, original.responsibilities_revision);

	const unchangedDuties = await store.updateAgent(original.agent_id, { duties: original.duties });
	assert.equal(unchangedDuties.responsibilities_revision, original.responsibilities_revision);
	assert.equal(unchangedDuties.responsibilities_updated_at, original.responsibilities_updated_at);

	const newDuties = await store.updateAgent(original.agent_id, { duties: "Updated duties" });
	assert.equal(newDuties.duties, "Updated duties");
	assert.equal(newDuties.responsibilities_revision, original.responsibilities_revision + 1);
	assert.equal(newDuties.responsibilities_updated_at, newDuties.last_seen_at);
	assert.equal(newDuties.instance_id, original.instance_id);

	const cleared = await store.updateAgent(original.agent_id, { teams: [] });
	assert.deepEqual(cleared.teams, []);
	assert.equal(cleared.duties, newDuties.duties);

	const beforeRejected = await store.getAgent(original.agent_id);
	await assert.rejects(() => store.updateAgent(original.agent_id, {}), /at least one/);
	await assert.rejects(() => store.updateAgent(original.agent_id, { name: "   " }), /name must not be empty/);
	await assert.rejects(() => store.updateAgent(original.agent_id, { duties: "   " }), /duties must not be empty/);
	await assert.rejects(() => store.updateAgent(original.agent_id, { teams: ["INVALID"] }), /team names must match/);
	assert.deepEqual(await store.getAgent(original.agent_id), beforeRejected);
});
