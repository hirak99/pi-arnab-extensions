import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("watch delivery uses steering custom notifications, never the user-input API", async () => {
	const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
	assert.doesNotMatch(source, /pi\.sendUserMessage/);
	assert.match(source, /registerMessageRenderer<WatchNotificationDetails>/);
	assert.match(source, /customType: WATCH_NOTIFICATION_TYPE/);
	assert.match(source, /sendNativeNotification\(pi, \{/);
});
