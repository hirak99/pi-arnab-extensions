// Connection test for pi-discord-remote config.
// Reads ~/.pi/agent/pi-discord-remote/config.json, attempts the same gateway
// login the extension performs, and reports the outcome. Never prints the token.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client, GatewayIntentBits } from "discord.js";

const CONFIG_FILE = join(homedir(), ".pi", "agent", "pi-discord-remote", "config.json");

const cfg = JSON.parse(await readFile(CONFIG_FILE, "utf-8"));
for (const key of ["token", "guildId"]) {
  if (!cfg[key] || String(cfg[key]).startsWith("PASTE_")) {
    console.error(`FAIL: config.json is missing a real value for "${key}".`);
    process.exit(2);
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});

const timeout = setTimeout(() => {
  console.error("FAIL: timed out after 20s without becoming ready.");
  process.exit(1);
}, 20_000);

client.once("ready", async (c) => {
  clearTimeout(timeout);
  console.log(`OK: logged in as ${c.user.tag}`);
  const guild = c.guilds.cache.get(cfg.guildId);
  if (!guild) {
    console.error(`FAIL: guild ${cfg.guildId} not visible — bot is not a member of that server.`);
    process.exit(1);
  }
  console.log(`OK: found server "${guild.name}"`);
  if (cfg.categoryId) {
    const cat = guild.channels.cache.get(cfg.categoryId);
    console.log(cat ? `OK: category "${cat.name}" exists` : `WARN: category ${cfg.categoryId} not found (channels will go to server root)`);
  }
  console.log(`OK: Message Content intent accepted — connection path is clear.`);
  await client.destroy();
  process.exit(0);
});

client.on("error", (err) => {
  clearTimeout(timeout);
  console.error(`FAIL: ${err.message}`);
  if (/disallowed intent/i.test(err.message)) {
    console.error("→ Enable 'Message Content Intent' in the Developer Portal (Bot page → Privileged Gateway Intents) and Save.");
  }
  if (/invalid token|incorrect login/i.test(err.message)) {
    console.error("→ The token is wrong or was copied with extra whitespace. Regenerate it in the portal.");
  }
  process.exit(1);
});

await client.login(cfg.token.trim());
