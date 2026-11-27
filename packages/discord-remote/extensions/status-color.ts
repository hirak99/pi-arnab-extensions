export type StatusTone = "info" | "success" | "warning" | "error";

/** Discord presence needs no attention color; retain only outer padding. */
export function colorStatus(
  text: string,
  _tone: StatusTone,
  _env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return ` ${text} `;
}
