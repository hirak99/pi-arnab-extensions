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
    expect(parsed).toHaveProperty("echo");
  });

  it("has sensible defaults", async () => {
    const { defaultConfigTemplate } = await import("../config.js");
    const parsed = JSON.parse(defaultConfigTemplate());
    expect(parsed.token).toBe("");
    expect(parsed.guildId).toBe("");
    expect(parsed.reactions).toBe(true);
    expect(parsed.echo).toBe(true);
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
      expect(result!.echo).toBe(true);
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

  it("defaults missing echo to true and preserves an explicit opt-out", async () => {
    const { loadConfig, saveConfig } = await import("../config.js");
    const origToken = process.env.DISCORD_TOKEN;
    delete process.env.DISCORD_TOKEN;

    try {
      await saveConfig({ token: "legacy-token", guildId: "legacy-guild" });
      expect((await loadConfig())!.echo).toBe(true);

      await saveConfig({ token: "quiet-token", guildId: "quiet-guild", echo: false });
      expect((await loadConfig())!.echo).toBe(false);
    } finally {
      if (origToken !== undefined) process.env.DISCORD_TOKEN = origToken;
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
      });

      const result = await loadConfig();
      expect(result).not.toBeNull();
      expect(result!.token).toBe("round-trip-token");
      expect(result!.guildId).toBe("round-trip-guild");
      expect(result!.allowedUserIds).toEqual(["a", "b"]);
      expect(result!.reactions).toBe(false);
    } finally {
      if (origToken !== undefined) process.env.DISCORD_TOKEN = origToken;
    }
  });
});

// ─── loadEffectiveConfig ─────────────────────────────────────────────────────

describe("loadEffectiveConfig", () => {
  async function makeProjectDir(): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), "pi-discord-remote-project-"));
    return dir;
  }

  async function writeProjectOverride(dir: string, contents: string): Promise<void> {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(dir, ".pi"), { recursive: true });
    await writeFile(join(dir, ".pi", "discord-remote.json"), contents);
  }

  it("returns the global config unchanged when no project file exists", async () => {
    const { loadEffectiveConfig, saveConfig } = await import("../config.js");

    const origToken = process.env.DISCORD_TOKEN;
    delete process.env.DISCORD_TOKEN;

    try {
      await saveConfig({ token: "global-token", guildId: "global-guild" });
      const projectDir = await makeProjectDir();

      const result = await loadEffectiveConfig(projectDir);
      expect(result).not.toBeNull();
      expect(result!.token).toBe("global-token");
      expect(result!.guildId).toBe("global-guild");
      expect(result!.autoStart).toBeUndefined();
    } finally {
      if (origToken !== undefined) process.env.DISCORD_TOKEN = origToken;
    }
  });

  it("merges project overrides over the global config", async () => {
    const { loadEffectiveConfig, saveConfig } = await import("../config.js");

    const origToken = process.env.DISCORD_TOKEN;
    delete process.env.DISCORD_TOKEN;

    try {
      await saveConfig({
        token: "global-token",
        guildId: "global-guild",
        categoryId: "global-category",
        autoStart: false,
      });
      const projectDir = await makeProjectDir();
      await writeProjectOverride(
        projectDir,
        JSON.stringify({ autoStart: true, categoryId: "project-category", echo: false }),
      );

      const result = await loadEffectiveConfig(projectDir);
      expect(result).not.toBeNull();
      // Overridden keys come from the project file…
      expect(result!.autoStart).toBe(true);
      expect(result!.categoryId).toBe("project-category");
      expect(result!.echo).toBe(false);
      // …everything else falls through to the global config.
      expect(result!.token).toBe("global-token");
      expect(result!.guildId).toBe("global-guild");
    } finally {
      if (origToken !== undefined) process.env.DISCORD_TOKEN = origToken;
    }
  });

  it("returns null when no global config exists, even with a project file", async () => {
    const { loadEffectiveConfig, CONFIG_FILE } = await import("../config.js");
    const { rm } = await import("node:fs/promises");

    const origToken = process.env.DISCORD_TOKEN;
    const origGuild = process.env.DISCORD_GUILD_ID;
    delete process.env.DISCORD_TOKEN;
    delete process.env.DISCORD_GUILD_ID;

    try {
      await rm(CONFIG_FILE, { force: true });
      const projectDir = await makeProjectDir();
      await writeProjectOverride(projectDir, JSON.stringify({ autoStart: true }));

      const result = await loadEffectiveConfig(projectDir);
      expect(result).toBeNull();
    } finally {
      if (origToken !== undefined) process.env.DISCORD_TOKEN = origToken;
      if (origGuild !== undefined) process.env.DISCORD_GUILD_ID = origGuild;
    }
  });

  it("falls back to the global config when the project file is invalid JSON", async () => {
    const { loadEffectiveConfig, saveConfig } = await import("../config.js");

    const origToken = process.env.DISCORD_TOKEN;
    delete process.env.DISCORD_TOKEN;

    try {
      await saveConfig({ token: "global-token", guildId: "global-guild" });
      const projectDir = await makeProjectDir();
      await writeProjectOverride(projectDir, "{ not json !");

      const result = await loadEffectiveConfig(projectDir);
      expect(result).not.toBeNull();
      expect(result!.token).toBe("global-token");
      expect(result!.guildId).toBe("global-guild");
    } finally {
      if (origToken !== undefined) process.env.DISCORD_TOKEN = origToken;
    }
  });

  it("returns the global config when cwd is undefined", async () => {
    const { loadEffectiveConfig, saveConfig } = await import("../config.js");

    const origToken = process.env.DISCORD_TOKEN;
    delete process.env.DISCORD_TOKEN;

    try {
      await saveConfig({ token: "global-token", guildId: "global-guild" });

      const result = await loadEffectiveConfig(undefined);
      expect(result).not.toBeNull();
      expect(result!.token).toBe("global-token");
    } finally {
      if (origToken !== undefined) process.env.DISCORD_TOKEN = origToken;
    }
  });
});

// ─── channel bindings (static channels) ──────────────────────────────────────

describe("loadChannelBindings + saveChannelBinding", () => {
  it("returns an empty object when no bindings file exists", async () => {
    const { loadChannelBindings, CHANNELS_FILE } = await import("../config.js");
    const { rm } = await import("node:fs/promises");
    await rm(CHANNELS_FILE, { force: true });

    const bindings = await loadChannelBindings();
    expect(bindings).toEqual({});
  });

  it("round-trips a binding for a project directory", async () => {
    const { loadChannelBindings, saveChannelBinding } = await import("../config.js");

    await saveChannelBinding("/proj/a", { channelId: "ch-1", channelName: "proj-a" });

    const bindings = await loadChannelBindings();
    expect(bindings["/proj/a"]).toEqual({ channelId: "ch-1", channelName: "proj-a" });
  });

  it("keeps bindings for other projects when adding a new one", async () => {
    const { loadChannelBindings, saveChannelBinding } = await import("../config.js");

    await saveChannelBinding("/proj/b", { channelId: "ch-2", channelName: "proj-b" });
    await saveChannelBinding("/proj/c", { channelId: "ch-3", channelName: "proj-c" });

    const bindings = await loadChannelBindings();
    expect(bindings["/proj/b"]).toEqual({ channelId: "ch-2", channelName: "proj-b" });
    expect(bindings["/proj/c"]).toEqual({ channelId: "ch-3", channelName: "proj-c" });
  });

  it("replaces the binding for the same project directory", async () => {
    const { loadChannelBindings, saveChannelBinding } = await import("../config.js");

    await saveChannelBinding("/proj/d", { channelId: "ch-old", channelName: "proj-d" });
    await saveChannelBinding("/proj/d", { channelId: "ch-new", channelName: "proj-d" });

    const bindings = await loadChannelBindings();
    expect(bindings["/proj/d"]).toEqual({ channelId: "ch-new", channelName: "proj-d" });
  });

  it("loadChannelBindings returns fresh data after each save", async () => {
    const { loadChannelBindings, saveChannelBinding } = await import("../config.js");

    const before = await loadChannelBindings();
    await saveChannelBinding("/proj/e", { channelId: "ch-e", channelName: "proj-e" });
    const after = await loadChannelBindings();

    expect(after["/proj/e"]).toEqual({ channelId: "ch-e", channelName: "proj-e" });
    expect(Object.keys(after).length).toBeGreaterThanOrEqual(Object.keys(before).length);
  });
});
