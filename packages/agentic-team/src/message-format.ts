const UUID_TEXT = String.raw`[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}`;
const INLINE_HEADER = new RegExp(
	String.raw`^Team message from [^\n]+ \(${UUID_TEXT}\), message (${UUID_TEXT}):(?:\n|$)`,
	"i",
);

export function formatInlineMessage(senderName: string, senderId: string, messageId: string, body: string): string {
	const displayName = senderName.replace(/\s+/g, " ").trim();
	return `Team message from ${displayName} (${senderId}), message ${messageId}:\n\n${body}`;
}

export function parseInlineMessageId(text: string): string | undefined {
	return INLINE_HEADER.exec(text)?.[1];
}
