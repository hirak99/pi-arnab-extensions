import { describe, expect, it } from "vitest";

import { colorStatus } from "../status-color.js";

describe("Discord status colors", () => {
  it("uses semantic pills and honors NO_COLOR", () => {
    expect(colorStatus("🔌 Discord: connected", "success", {})).toMatch(/^\x1b\[48;2;183;235;190m/);
    expect(colorStatus("🔄 Discord: reconnecting", "warning", {})).toMatch(/^\x1b\[48;2;255;226;163m/);
    expect(colorStatus("⚠️ Discord: error", "error", {})).toMatch(/Discord: error\x1b\[0m$/);
    expect(colorStatus("⚠️ Discord: error", "error", { NO_COLOR: "1" })).toBe("⚠️ Discord: error");
  });
});
