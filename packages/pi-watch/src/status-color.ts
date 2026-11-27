export type StatusTone = "standard" | "info" | "warning";

export interface StatusHighlight {
	text: string;
	tone: "warning" | "error";
}

const BACKGROUNDS: Record<"info" | "warning", readonly [string, string]> = {
	info: ["\x1b[48;2;183;223;255m", "\x1b[38;2;11;70;110m"],
	warning: ["\x1b[48;2;255;226;163m", "\x1b[38;2;86;54;0m"],
};

const FOREGROUNDS: Record<"warning" | "error", string> = {
	warning: "\x1b[38;2;150;95;0m",
	error: "\x1b[38;2;180;25;25m",
};

/**
 * Blue when every watcher is active; amber when any retained watcher is
 * inactive. Colored suffixes restore the background so it spans the full item,
 * including both outer spaces. NO_COLOR retains identical spacing.
 */
export function colorStatus(
	text: string,
	tone: StatusTone,
	env: Readonly<Record<string, string | undefined>> = process.env,
	highlights: StatusHighlight[] = [],
): string {
	const label = ` ${text} `;
	if (env.NO_COLOR !== undefined || (tone === "standard" && highlights.length === 0)) return label;
	const background = tone === "standard" ? undefined : BACKGROUNDS[tone];
	const restore = background?.join("") ?? "\x1b[0m";
	let body = label;
	for (const highlight of highlights) {
		body = body.replace(highlight.text, `${FOREGROUNDS[highlight.tone]}${highlight.text}${restore}`);
	}
	return background ? `${background.join("")}${body}\x1b[0m` : body;
}
