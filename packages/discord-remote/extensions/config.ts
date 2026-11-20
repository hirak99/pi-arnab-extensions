/**
 * Config management for pi-discord-remote.
 * Config is persisted to ~/.pi/agent/pi-discord-remote/config.json.
 *
 * The directory can be overridden with the PI_DISCORD_REMOTE_CONFIG_DIR
 * env var — tests use this to point at an isolated temp dir so they never
 * touch the real config.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export const CONFIG_DIR =
  process.env.PI_DISCORD_REMOTE_CONFIG_DIR ??
  join(homedir(), ".pi", "agent", "pi-discord-remote");
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export interface Config {
  token: string;
  /** Discord guild (server) ID — required for auto-channel creation */
  guildId: string;
  /** Optional category ID to put new channels under */
  categoryId?: string;
  /** Fallback channel ID when not creating a new channel (legacy) */
  channelId?: string;
  /** Optional allow-list of Discord user IDs. Empty = allow everyone. */
  allowedUserIds?: string[];
  /** React with emoji while processing (default: true) */
  reactions?: boolean;
  /** Optional display-name overrides keyed by Discord user ID, e.g. { "123…": "Arnab" }.
   * Matched first, before nickname / global name / username fallbacks.
   * Friendly names are shown with the <@userID> mention token. A null value marks
   * the default user: their messages are injected with no attribution prefix at all. */
  displayNames?: Record<string, string | null>;
  /** Mirror session activity that did NOT originate from Discord into the
   * channel: prompts typed in the pi terminal, their tool-call labels, and
   * the assistant's replies (default: false — only Discord-originated turns
   * are mirrored). */
  echo?: boolean;
  /** Inject messages received while a turn is running into that turn
   * ("steering": the agent sees them at its next step, before its next LLM
   * call) instead of replying "please wait" and dropping them
   * (default: false). */
  steer?: boolean;
  /** Connect to Discord automatically when a new or resumed session starts
   * (default: false — connect only via /pi-discord-remote start). Intended
   * as a per-project opt-in in .pi/discord-remote.json, but honored in the
   * global config too. Reloads are never auto-connected: the existing
   * connection survives a reload. */
  autoStart?: boolean;
  /** Keep the session's Discord channel across sessions instead of deleting
   * it on session end: the channel is locked read-only with a closing
   * message, and reused (unlocked) when the next session in the same project
   * starts (default: false). */
  staticChannel?: boolean;
  /** Explicit channel name — no date suffix, honored whether or not
   * staticChannel is set. Without it, the name is the slugified project
   * directory name for static channels, or a date-suffixed per-session
   * name otherwise. */
  channelName?: string;
}

/** Persisted binding between a project directory and its static channel. */
export interface ChannelBinding {
  channelId: string;
  channelName: string;
}

export const CHANNELS_FILE = join(CONFIG_DIR, "channels.json");

/** All known project→channel bindings (empty object when none / unreadable). */
export async function loadChannelBindings(): Promise<Record<string, ChannelBinding>> {
  try {
    return JSON.parse(await readFile(CHANNELS_FILE, "utf-8")) as Record<string, ChannelBinding>;
  } catch {
    return {};
  }
}

/** Record (or replace) the binding for a project directory. */
export async function saveChannelBinding(cwd: string, binding: ChannelBinding): Promise<void> {
  const bindings = await loadChannelBindings();
  bindings[cwd] = binding;
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CHANNELS_FILE, JSON.stringify(bindings, null, 2) + "\n");
}

/** Name of the optional per-project override file inside <project>/.pi/. */
export const PROJECT_CONFIG_NAME = "discord-remote.json";

export async function loadConfig(): Promise<Config | null> {
  try {
    const cfg = JSON.parse(await readFile(CONFIG_FILE, "utf-8")) as Config;
    // Allow DISCORD_TOKEN env var to override the config token
    if (process.env.DISCORD_TOKEN) {
      cfg.token = process.env.DISCORD_TOKEN;
    }
    return cfg;
  } catch {
    // Fall back to env var only (useful for CI / headless setups)
    if (process.env.DISCORD_TOKEN && process.env.DISCORD_GUILD_ID) {
      return {
        token: process.env.DISCORD_TOKEN,
        guildId: process.env.DISCORD_GUILD_ID,
        categoryId: process.env.DISCORD_CATEGORY_ID,
        reactions: true,
      };
    }
    return null;
  }
}

/**
 * Global config merged with the optional per-project override file at
 * `<cwd>/.pi/discord-remote.json`. Project values win. The file only needs
 * the keys it overrides — typically `{ "autoStart": true }` or a
 * project-specific categoryId; the bot token is always available from the
 * global config. A missing file is not an error; an unparseable one logs a
 * warning and falls back to the global config.
 */
export async function loadEffectiveConfig(cwd: string | undefined): Promise<Config | null> {
  const global = await loadConfig();
  if (!global || !cwd) return global;
  const projectFile = join(cwd, ".pi", PROJECT_CONFIG_NAME);
  try {
    const overrides = JSON.parse(await readFile(projectFile, "utf-8")) as Partial<Config>;
    return { ...global, ...overrides };
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      console.warn(`[pi-discord-remote] Ignoring unparseable ${projectFile}:`, err?.message);
    }
    return global;
  }
}

export async function saveConfig(cfg: Config): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n");
}

/** Default config template shown in the editor when no config exists. */
export function defaultConfigTemplate(): string {
  return (
    JSON.stringify(
      {
        token: "",
        guildId: "",
        categoryId: "",
        allowedUserIds: [],
        reactions: true,
      },
      null,
      2,
    ) + "\n"
  );
}
