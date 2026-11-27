export type StatusTone = "standard" | "info" | "warning" | "error";

export interface StatusHighlight {
	text: string;
	tone: "warning" | "error";
}

const STYLES: Record<Exclude<StatusTone, "standard">, readonly [string, string]> = {
	info: ["\x1b[48;2;183;223;255m", "\x1b[38;2;11;70;110m"],
	warning: ["\x1b[38;2;150;95;0m", ""],
	error: ["\x1b[38;2;180;25;25m", ""],
};

/**
 * Standard text unless active (info), with optional foreground-only suffixes.
 * Colored suffixes restore the activity pill so its background spans the full
 * label, including both outer spaces. NO_COLOR retains identical spacing.
 */
export function colorStatus(
	text: string,
	tone: StatusTone,
	env: Readonly<Record<string, string | undefined>> = process.env,
	highlights: StatusHighlight[] = [],
): string {
	const label = ` ${text} `;
	if (env.NO_COLOR !== undefined || (tone === "standard" && highlights.length === 0)) return label;
	const active = tone === "info";
	const restore = active ? STYLES.info.join("") : "\x1b[0m";
	let body = label;
	for (const highlight of highlights) {
		const foreground = STYLES[highlight.tone][0];
		body = body.replace(highlight.text, `${foreground}${highlight.text}${restore}`);
	}
	return active ? `${STYLES.info.join("")}${body}\x1b[0m` : body;
}
