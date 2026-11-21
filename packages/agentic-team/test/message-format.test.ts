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

test("inline replies expose threading without altering the body", () => {
	const sender = randomUUID();
	const message = randomUUID();
	const original = randomUUID();
	const body = "Reply body";
	const prompt = formatInlineMessage("Sender", sender, message, body, original);

	assert.equal(parseInlineMessageId(prompt), message);
	assert.ok(prompt.startsWith(
		`Team message from Sender (${sender}), message ${message}, in reply to ${original}:\n\n`,
	));
	assert.ok(prompt.endsWith(body));
});

test("malformed reply IDs do not inject notification header lines", () => {
	const prompt = formatInlineMessage("Sender", randomUUID(), randomUUID(), "Body", "invalid\nInjected");
	assert.doesNotMatch(prompt, /in reply to|Injected/);
	assert.ok(prompt.endsWith("Body"));
});

test("non-inline and malformed prompts do not generate read receipts", () => {
	assert.equal(parseInlineMessageId("Team message 123 is waiting in your inbox."), undefined);
	assert.equal(parseInlineMessageId("Team message from Sender (invalid), message invalid:\n\nBody"), undefined);
	assert.equal(parseInlineMessageId("Ordinary user input"), undefined);
});
