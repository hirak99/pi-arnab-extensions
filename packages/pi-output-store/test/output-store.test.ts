import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { BoundedOutput, deleteOutput, ensureTemporaryOutputRoot, readOutput, readOutputLines, temporaryOutputBase } from "../src/index.ts";

async function fixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "pi-output-store-test-"));
	t.after(async () => { await rm(root, { recursive: true, force: true }); });
	return join(root, "job.output");
}

test("temporary output uses a known per-user private root", async (t) => {
	const root = await ensureTemporaryOutputRoot("output-store-test");
	t.after(async () => { await rm(root, { recursive: true, force: true }); });
	assert.equal(root, join(temporaryOutputBase(), "output-store-test"));
	assert.equal((await stat(root)).mode & 0o777, 0o700);
});

test("fixed-path rotation bounds segments and counts physically omitted lines", async (t) => {
	const path = await fixture(t);
	const output = new BoundedOutput(path, { maxSegmentBytes: 8 });
	for (let index = 1; index <= 13; index++) await output.append(`${index}\n`);
	await output.close();
	assert.equal((await stat(path)).size <= 8, true);
	assert.equal((await stat(`${path}.1`)).size <= 8, true);
	const result = await readOutputLines(path, 20);
	assert.deepEqual(result.lines, ["9", "10", "11", "12", "13"]);
	assert.equal(result.omittedLines, 8);
	assert.match(await readFile(`${path}.state.json`, "utf8"), /"omitted_lines":8/);
	await deleteOutput(path);
	await assert.rejects(stat(path), { code: "ENOENT" });
	await assert.rejects(stat(`${path}.1`), { code: "ENOENT" });
	await assert.rejects(stat(`${path}.state.json`), { code: "ENOENT" });
});

test("large chunks are split without exceeding the segment byte bound", async (t) => {
	const path = await fixture(t);
	const output = new BoundedOutput(path, { maxSegmentBytes: 5 });
	await output.append("1234567890123");
	await output.close();
	assert.equal((await stat(path)).size <= 5, true);
	assert.equal((await stat(`${path}.1`)).size <= 5, true);
	assert.equal((await readOutput(path, { maxBytes: 50 })).text, "67890123");
});

test("close and reopen preserve omitted-line accounting and missing files are readable", async (t) => {
	const path = await fixture(t);
	let output = new BoundedOutput(path, { maxSegmentBytes: 4 });
	for (let index = 0; index < 8; index++) await output.append("x\n");
	await output.close();
	assert.equal((await readOutputLines(path)).omittedLines, 4);
	output = new BoundedOutput(path, { maxSegmentBytes: 4 });
	await output.append("y\n");
	assert.equal((await readOutputLines(path)).omittedLines, 6);
	await output.delete();
	assert.deepEqual(await readOutputLines(path), { path, lines: [], omittedLines: 0 });
	assert.equal((await readOutput(path)).text, "");
});

test("byte reads span rotated and current segments and report truncation", async (t) => {
	const path = await fixture(t);
	const output = new BoundedOutput(path, { maxSegmentBytes: 6 });
	await output.append("aaa\nbbb\nccc\n");
	await output.close();
	const result = await readOutput(path, { maxBytes: 5, tail: true });
	assert.equal(result.text, "\nccc\n");
	assert.equal(result.bytesRead, 5);
	assert.equal(result.totalBytes, 12);
	assert.equal(result.truncated, true);
	assert.equal(result.omittedLines, 0);
});
