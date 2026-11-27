const UUID_TEXT = String.raw`[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}`;
const INLINE_HEADER = new RegExp(
	String.raw`^Team (?:message|broadcast) from [^\n]+ \(${UUID_TEXT}\)(?: to [^\n]+)?, message (${UUID_TEXT})(?:, in reply to ${UUID_TEXT})?:(?:\n|$)`,
	"i",
);
const MESSAGE_ID = new RegExp(String.raw`^${UUID_TEXT}$`, "i");

export function isTeamMessageId(value: unknown): value is string {
	return typeof value === "string" && MESSAGE_ID.test(value);
}

export function formatInlineMessage(
	senderName: string,
	senderId: string,
	messageId: string,
	body: string,
	replyTo?: string | null,
	broadcast?: { teams?: string[] | undefined },
): string {
	const displayName = senderName.replace(/\s+/g, " ").trim();
	const threading = isTeamMessageId(replyTo) ? `, in reply to ${replyTo}` : "";
	const audience = broadcast ? ` to ${broadcast.teams?.length ? broadcast.teams.join(", ") : "all agents"}` : "";
	const kind = broadcast ? "Team broadcast" : "Team message";
	return `${kind} from ${displayName} (${senderId})${audience}, message ${messageId}${threading}:\n\n${body}`;
}

export function parseInlineMessageId(text: string): string | undefined {
	return INLINE_HEADER.exec(text)?.[1];
}
