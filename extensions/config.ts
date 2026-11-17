/**
 * Config management for pi-discord-remote.
 * Config is persisted to ~/.pi/agent/pi-discord-remote/config.json.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export const CONFIG_DIR = join(homedir(), ".pi", "agent", "pi-discord-remote");
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
  /** Also send tool responses (output/results) after each tool call (default: false) */
  toolResponses?: boolean;
  /** Optional display-name overrides keyed by Discord user ID, e.g. { "123…": "Arnab" }.
   * Matched first, before nickname / global name / username fallbacks. */
  displayNames?: Record<string, string>;
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
  /** Stream the assistant's in-progress text into a single Discord message
   * edited in place (throttled to respect rate limits; the live view shows
   * the text tail, the full reply is still posted when the turn ends)
   * (default: false). */
  stream?: boolean;
}

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
        toolResponses: false,
      };
    }
    return null;
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
        // Set to true to also post tool outputs/results after each tool call
        toolResponses: false,
      },
      null,
      2,
    ) + "\n"
  );
}
