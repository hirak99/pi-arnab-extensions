import assert from "node:assert/strict";
import test from "node:test";

import watchExtension from "../src/index.ts";

test("every registered watch tool appears in Pi's prompt tool summary", () => {
	const tools: Array<{ name: string; promptSnippet?: string }> = [];
	const pi = {
		events: { on: () => () => {} },
		registerMessageRenderer() {},
		on() {},
		registerTool(definition: { name: string; promptSnippet?: string }) {
			tools.push(definition);
		},
	};
	watchExtension(pi as any);

	assert.deepEqual(
		tools.map(({ name }) => name).sort(),
		[
			"watch_create_poll",
			"watch_create_stream",
			"watch_export",
			"watch_inspect",
			"watch_list",
			"watch_pause",
			"watch_remove",
			"watch_resume",
			"watch_tail",
		].sort(),
	);
	for (const tool of tools) {
		assert.ok(tool.promptSnippet?.trim(), `${tool.name} needs a promptSnippet to appear in the tools summary`);
	}
});
