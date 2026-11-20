import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { formatInlineMessage, parseInlineMessageId } from "../src/message-format.ts";

test("inline messages expose sender and message IDs without altering the body", () => {
	const sender = randomUUID();
	const message = randomUUID();
	const body = "First line.\nSecond line with `code` and symbols: $HOME; \"quotes\".";
	const prompt = formatInlineMessage("Sender\nName", sender, message, body);

	assert.equal(parseInlineMessageId(prompt), message);
	assert.ok(prompt.startsWith(`Team message from Sender Name (${sender}), message ${message}:\n\n`));
	assert.ok(prompt.endsWith(body));
});

test("non-inline and malformed prompts do not generate read receipts", () => {
	assert.equal(parseInlineMessageId("Team message 123 is waiting in your inbox."), undefined);
	assert.equal(parseInlineMessageId("Team message from Sender (invalid), message invalid:\n\nBody"), undefined);
	assert.equal(parseInlineMessageId("Ordinary user input"), undefined);
});
