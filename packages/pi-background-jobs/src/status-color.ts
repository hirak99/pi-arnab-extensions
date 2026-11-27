export type StatusTone = "standard" | "info";

const STYLES: Record<Exclude<StatusTone, "standard">, readonly [string, string]> = {
	info: ["\x1b[48;2;183;223;255m", "\x1b[38;2;11;70;110m"],
};

/** Blue while running; standard text otherwise, with identical outer padding. */
export function colorStatus(
	text: string,
	tone: StatusTone,
	env: Readonly<Record<string, string | undefined>> = process.env,
): string {
	const label = ` ${text} `;
	if (tone === "standard" || env.NO_COLOR !== undefined) return label;
	const [background, foreground] = STYLES[tone];
	return `${background}${foreground}${label}\x1b[0m`;
}
