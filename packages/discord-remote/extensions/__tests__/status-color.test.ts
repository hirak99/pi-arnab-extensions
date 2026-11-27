import { describe, expect, it } from "vitest";
import { colorStatus } from "../status-color.js";

describe("Discord status styling", () => {
  it.each(["info", "success", "warning", "error"] as const)("uses standard padded text for %s", (tone) => {
    expect(colorStatus("💬 Discord: connected", tone, {})).toBe(" 💬 Discord: connected ");
    expect(colorStatus("💬 Discord: connected", tone, { NO_COLOR: "1" })).toBe(" 💬 Discord: connected ");
  });
});
