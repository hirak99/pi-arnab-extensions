import assert from "node:assert/strict";
import test from "node:test";

import { sendNativeNotification } from "../src/native-notification.ts";

test("native notifications always request steering and a turn without reading session state", () => {
	const calls: any[] = [];
	const pi = { sendMessage: (message: any, options: any) => calls.push({ message, options }) };
	sendNativeNotification(pi, {
		customType: "team-message-notification",
		content: "steer now",
		details: { messageId: "message-1" },
	});
	assert.deepEqual(calls, [{
		message: {
			customType: "team-message-notification",
			content: "steer now",
			display: true,
			details: { messageId: "message-1" },
		},
		options: { deliverAs: "steer", triggerTurn: true },
	}]);
});
