# Operational notes

How to get a Discord channel driving a pi session again: from scratch, or
after things break. These notes complement the README's "Fork additions"
section with day-to-day operations and diagnosis.

## Typical layout on a machine running this fork

| Piece | Location |
|---|---|
| The fork (extension source) | `~/git/pi-discord-remote` |
| Loaded via symlink | `~/.pi/agent/extensions/pi-discord-remote` → the fork |
| Bot config (token, server, allow-list, fork flags) | `~/.pi/agent/pi-discord-remote/config.json` |
| Bot itself | Discord Developer Portal (account-level, survives anything) |
| Discord server + bot invite | one-time — the bot is a member |

**Reconnect after, say, a reboot** — nothing to prep:

```bash
# 1. start pi (tmux/nohup if you want it to survive disconnects)
pi
# 2. inside pi:
/pi-discord-remote start
# 3. optional check
/pi-discord-remote status
```

A channel named `<project>-<date>` appears in your Discord server. Type there =
a turn in this session. `/pi-discord-remote stop` tears the channel down.

## If it's broken, diagnose in this order

1. **Is the extension loaded?** In pi, is `/pi-discord-remote` in the command
   list? If not: check the symlink exists
   (`ls -la ~/.pi/agent/extensions/`), and if pi was updated, reload settings
   with `/reload` or restart pi.
2. **Config sane?** `cat ~/.pi/agent/pi-discord-remote/config.json` — needs
   `token`, `guildId`, and your numeric user ID in `allowedUserIds`.
   Run the diagnostic: `node ~/git/pi-discord-remote/test-connect.mjs` —
   it says exactly which of token / intents / guild / permissions is wrong
   (it never prints the token).
3. **Classic failures and fixes:**
   - `Used disallowed intents` → Developer Portal → your app → **Bot** page →
     **Privileged Gateway Intents** → enable **Message Content Intent** →
     **Save Changes** (saving is the step everyone misses).
   - `Could not create channel` / permission errors → re-invite the bot:
     OAuth2 → URL Generator → scope `bot` + permissions **View Channels**,
     **Send Messages**, **Add Reactions**, **Manage Channels**, **Manage
     Roles** → open URL → authorize. Re-inviting just updates permissions.
     (Manage Roles is required for static-channel lock/unlock — editing
     channel permission overwrites is gated on it, not on Manage Channels.)
   - `DiscordAPIError[50013]: Missing Permissions` on `…/channels/<id>/
     permissions/<id>` when a static channel is adopted/ended → same fix:
     the bot role needs **Manage Roles** (see above). The lock/unlock
     failure is non-fatal — everything else keeps working.
   - Static channel "not read-only" when tested by the server owner/admin →
     expected: Administrator bypasses every channel overwrite. Verify the
     lock with a non-privileged account, or check Edit Channel →
     Permissions → `@everyone` Send Messages = ❌.
   - `Your user ID is not on the allow-list` → a username was pasted, not an
     ID. Right-click your own name in the member list → **Copy User ID**
     (needs Developer Mode on). Must be a 17–20 digit number. Then
     `/pi-discord-remote stop` + `start` (config is snapshotted at connect).
   - Bot offline in Discord → the pi session hosting it isn't running or the
     extension was stopped. `/pi-discord-remote status` tells you.

## Editing the fork

```bash
cd ~/git/pi-discord-remote
# edit extensions/*.ts, then:
npm run build
# then FULL pi restart (/reload does NOT pick up rebuilds — module stays cached):
# exit pi, relaunch, /pi-discord-remote start
```

Update the `~/.pi/agent/extensions/pi-discord-remote` symlink if the clone
ever moves. Commit early; push when you want the work backed up remotely.

## Fork feature flags (all opt-in, default off)

- `displayNames` — `[Name]:` attribution on Discord-originated prompts.
  Value per user ID: string overrides the name, `null` marks the default
  user (no prefix at all). No entry → server nickname → global name →
  @username, with prefix.
- `echo: true` — terminal-typed turns are mirrored into the channel, with a
  divider marking the boundary before the agent's reply.
- `steer: true` — Discord messages sent mid-turn are injected into the
  running turn (delivered before the agent's next LLM call), not dropped.
- `autoStart: true` (per-project `.pi/discord-remote.json`) — connect
  automatically when a new/resumed session starts in that project.
- `staticChannel: true` (same file) — keep the project's channel across
  sessions: 🔒 read-only (`@everyone` Send Messages deny) at session end,
  🔓 reused/unlocked by the next session. Needs **Manage Roles** on the bot.
  Optional `channelName` sets an explicit channel name (no date suffix),
  with or without static mode. Changing it renames the bound channel on the
  next session (binding is by ID — history moves with the rename).

Assistant output is append-only: each completed assistant message is posted
at `message_end`, in transcript order. `agent_end` adds only the completion
mention/divider footer, so steering messages cannot merge adjacent replies.
Tool-call starts are posted as short emoji/path summaries; commands, search
patterns, and tool results are never mirrored. Discord typing follows Pi's
`Working` lifecycle (`turn_start` to `agent_end`) with an 8-second refresh.
Subagents post immediate ✅/❌ completions and an `agent_end` running snapshot
(🆕 new, ⏳ previously reported), using descriptions with a type fallback.
Aborted runs post `🛑 Agent interrupted` at `agent_settled`.

See the README's "Fork additions" section for full descriptions.

## Possible follow-ups

- **True abort (`!`-style interrupt)** — kill a running tool/turn on demand.
  Blocked: pi exposes `ctx.abort()` only inside event-handler contexts, not
  to the Discord message path. Candidate for an upstream pi feature request.
- **Version indicator** — show git commit hash + commits-ahead in
  `/pi-discord-remote status`, derived at build time (no manual bumping).
- **Hot-reload upstream issue** — pi's `/reload` keeps stale extension module
  code (verified: no re-import even for auto-discovered extensions), so every
  fork change needs a full pi restart. Worth reporting upstream.

## Borrowed ideas (from [discord_agent](https://github.com/jcl5m1/discord_agent), jcl5m1)

Both projects bridge Discord to coding agents, but they solve different
problems. **This fork** is a window into your live pi session — full context,
tools, and extensions, because it runs inside pi itself. **discord_agent** is
an independent, always-on harness that spawns agent CLI processes per
message. Reach for it when you want:

- Multiple independent agent instances running in parallel, each in its own
  channel and working directory, surviving restarts on their own
- Agents that keep working without a pi (or any terminal) session running
- Its built-in extras: WhatsApp mirroring, CI/webhook triggers, HTML→image
  rendering, rendered tables, per-agent file sharing, `/update` self-hosting
  plumbing (systemd, watchdog, uptime)

Compared against discord_agent's feature set. Most of its slash commands
exist because it has no native interface — pi's TUI already covers /model,
/session, /login, resume. Candidates worth porting someday:

- **Stop button / typed `stop`** — true abort (same `ctx.abort()` context
  blocker as above; a ⏹ button needs the same escape hatch, so it's one
  feature)
- **`/model` from Discord** — pi exposes `setModel`/`getModel` to extensions;
  feasible, niche
- **`/logs` to Discord** — post pi's recent errors on demand for phone
  debugging

Deliberately not ported: `/update` (auto-restarting the host process is
risky, keep manual), `/uptime` (self-hosting concern), `/files`, `/whatsapp`,
`/triggers` (CI webhooks — big build, discord_agent's standout feature if
ever needed).
