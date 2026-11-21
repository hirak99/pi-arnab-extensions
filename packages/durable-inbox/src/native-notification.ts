export interface NativeNotificationApi {
	sendMessage<T = unknown>(
		message: { customType: string; content: string; display: boolean; details?: T },
		options: { deliverAs: "steer" | "followUp"; triggerTurn: boolean },
	): void;
}

export interface NativeNotificationInput<T = unknown> {
	customType: string;
	content: string;
	details?: T;
}

/**
 * Deliver a visible custom message without entering Pi's user-input path.
 * Pi steers active runs and starts a new run when idle because triggerTurn is true.
 */
export function sendNativeNotification<T>(
	pi: NativeNotificationApi,
	input: NativeNotificationInput<T>,
): void {
	pi.sendMessage(
		{ ...input, display: true },
		{ deliverAs: "steer", triggerTurn: true },
	);
}
