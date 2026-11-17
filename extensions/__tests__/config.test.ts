import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Point the config module at an isolated temp dir BEFORE it is imported
// (all imports of ../config.js below are dynamic, so this runs first).
// Without this, saveConfig/loadConfig would read and delete the user's real
// config at ~/.pi/agent/pi-discord-remote/config.json.
const tempDir = mkdtempSync(join(tmpdir(), "pi-discord-remote-test-"));
process.env.PI_DISCORD_REMOTE_CONFIG_DIR = tempDir;

// ─── defaultConfigTemplate ────────────────────────────────────────────────────

describe("defaultConfigTemplate", () => {
  it("returns valid JSON", async () => {
    const { defaultConfigTemplate } = await import("../config.js");
    const tpl = defaultConfigTemplate();
    const parsed = JSON.parse(tpl);
    expect(parsed).toBeDefined();
  });

  it("has the expected keys", async () => {
    const { defaultConfigTemplate } = await import("../config.js");
    const parsed = JSON.parse(defaultConfigTemplate());
    expect(parsed).toHaveProperty("token");
    expect(parsed).toHaveProperty("guildId");
    expect(parsed).toHaveProperty("categoryId");
    expect(parsed).toHaveProperty("allowedUserIds");
    expect(parsed).toHaveProperty("reactions");
    expect(parsed).toHaveProperty("toolResponses");
  });

  it("has sensible defaults", async () => {
    const { defaultConfigTemplate } = await import("../config.js");
    const parsed = JSON.parse(defaultConfigTemplate());
    expect(parsed.token).toBe("");
    expect(parsed.guildId).toBe("");
    expect(parsed.reactions).toBe(true);
    expect(parsed.toolResponses).toBe(false);
    expect(parsed.allowedUserIds).toEqual([]);
  });

  it("ends with a newline", async () => {
    const { defaultConfigTemplate } = await import("../config.js");
    expect(defaultConfigTemplate()).toMatch(/\n$/);
  });
});

// ─── saveConfig / loadConfig ──────────────────────────────────────────────────

describe("saveConfig + loadConfig", () => {
  // Each test gets a fresh config file by deleting the temp copy; the real
  // user config is never involved (see the env override at the top).
  async function removeTempConfig(): Promise<void> {
    const { CONFIG_FILE } = await import("../config.js");
    await rm(CONFIG_FILE, { force: true });
  }

  it("saveConfig writes valid JSON", async () => {
    const { saveConfig, CONFIG_FILE } = await import("../config.js");

    const cfg = {
      token: "test-token-123",
      guildId: "guild-456",
      categoryId: "cat-789",
      allowedUserIds: ["user1", "user2"],
      reactions: false,
      toolResponses: true,
    };

    await saveConfig(cfg);

    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(CONFIG_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.token).toBe("test-token-123");
    expect(parsed.guildId).toBe("guild-456");
    expect(parsed.categoryId).toBe("cat-789");
    expect(parsed.allowedUserIds).toEqual(["user1", "user2"]);
    expect(parsed.reactions).toBe(false);
    expect(parsed.toolResponses).toBe(true);
  });

  it("loadConfig returns null when no config file and no env vars", async () => {
    const { loadConfig } = await import("../config.js");

    const origToken = process.env.DISCORD_TOKEN;
    const origGuild = process.env.DISCORD_GUILD_ID;
    delete process.env.DISCORD_TOKEN;
    delete process.env.DISCORD_GUILD_ID;

    try {
      await removeTempConfig();
      const result = await loadConfig();
      expect(result).toBeNull();
    } finally {
      if (origToken !== undefined) process.env.DISCORD_TOKEN = origToken;
      if (origGuild !== undefined) process.env.DISCORD_GUILD_ID = origGuild;
    }
  });

  it("loadConfig falls back to env vars when no file exists", async () => {
    const { loadConfig } = await import("../config.js");

    const origToken = process.env.DISCORD_TOKEN;
    const origGuild = process.env.DISCORD_GUILD_ID;
    const origCategory = process.env.DISCORD_CATEGORY_ID;

    process.env.DISCORD_TOKEN = "env-token";
    process.env.DISCORD_GUILD_ID = "env-guild";
    process.env.DISCORD_CATEGORY_ID = "env-category";

    try {
      await removeTempConfig();
      const result = await loadConfig();
      expect(result).not.toBeNull();
      expect(result!.token).toBe("env-token");
      expect(result!.guildId).toBe("env-guild");
      expect(result!.categoryId).toBe("env-category");
      expect(result!.reactions).toBe(true);
      expect(result!.toolResponses).toBe(false);
    } finally {
      if (origToken !== undefined) process.env.DISCORD_TOKEN = origToken;
      else delete process.env.DISCORD_TOKEN;
      if (origGuild !== undefined) process.env.DISCORD_GUILD_ID = origGuild;
      else delete process.env.DISCORD_GUILD_ID;
      if (origCategory !== undefined) process.env.DISCORD_CATEGORY_ID = origCategory;
      else delete process.env.DISCORD_CATEGORY_ID;
    }
  });

  it("DISCORD_TOKEN env var overrides file token", async () => {
    const { loadConfig, saveConfig } = await import("../config.js");

    const origToken = process.env.DISCORD_TOKEN;
    process.env.DISCORD_TOKEN = "override-token";

    try {
      await saveConfig({
        token: "file-token",
        guildId: "some-guild",
      });

      const result = await loadConfig();
      expect(result).not.toBeNull();
      expect(result!.token).toBe("override-token");
      expect(result!.guildId).toBe("some-guild");
    } finally {
      if (origToken !== undefined) process.env.DISCORD_TOKEN = origToken;
      else delete process.env.DISCORD_TOKEN;
    }
  });

  it("loadConfig reads a previously saved config", async () => {
    const { loadConfig, saveConfig } = await import("../config.js");

    const origToken = process.env.DISCORD_TOKEN;
    delete process.env.DISCORD_TOKEN;

    try {
      await saveConfig({
        token: "round-trip-token",
        guildId: "round-trip-guild",
        allowedUserIds: ["a", "b"],
        reactions: false,
        toolResponses: true,
      });

      const result = await loadConfig();
      expect(result).not.toBeNull();
      expect(result!.token).toBe("round-trip-token");
      expect(result!.guildId).toBe("round-trip-guild");
      expect(result!.allowedUserIds).toEqual(["a", "b"]);
      expect(result!.reactions).toBe(false);
      expect(result!.toolResponses).toBe(true);
    } finally {
      if (origToken !== undefined) process.env.DISCORD_TOKEN = origToken;
    }
  });
});
