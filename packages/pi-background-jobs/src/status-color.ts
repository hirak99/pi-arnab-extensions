export type StatusTone = "info" | "success" | "warning" | "error";

const STYLES: Record<StatusTone, readonly [string, string]> = {
	info: ["\x1b[48;2;183;223;255m", "\x1b[38;2;11;70;110m"],
	success: ["\x1b[48;2;183;235;190m", "\x1b[38;2;12;70;30m"],
	warning: ["\x1b[48;2;255;226;163m", "\x1b[38;2;86;54;0m"],
	error: ["\x1b[48;2;255;190;190m", "\x1b[38;2;105;20;20m"],
};

/** Soft status pill with one outer space; NO_COLOR retains identical spacing. */
export function colorStatus(
	text: string,
	tone: StatusTone,
	env: Readonly<Record<string, string | undefined>> = process.env,
): string {
	const label = ` ${text} `;
	if (env.NO_COLOR !== undefined) return label;
	const [background, foreground] = STYLES[tone];
	return `${background}${foreground}${label}\x1b[0m`;
}
