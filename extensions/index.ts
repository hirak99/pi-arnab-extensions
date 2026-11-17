/**
 * pi-discord-remote — control this Pi session from Discord
 *
 * Each /pi-discord-remote start creates a fresh text channel named after the
 * current working directory + date (e.g. "kaleidoscope-may09").  On stop
 * (or session shutdown) the channel is deleted to stay within Discord's
 * per-server channel limit.
 *
 * Bot permissions required:
 *   • Read/Send Messages, Add Reactions  (existing)
 *   • Manage Channels                    (new — for create + rename)
 *
 * Commands:
 *   /pi-discord-remote setup       — interactive setup (token, guildId, categoryId, allowed users)
 *   /pi-discord-remote start       — create channel + connect
 *   /pi-discord-remote stop        — delete channel + disconnect
 *   /pi-discord-remote status      — show connection state
 *   /pi-discord-remote open-config — edit config.json in the editor
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  Client,
  ChannelType,
  GatewayIntentBits,
  Partials,
  type Message,
  type TextChannel,
} from "discord.js";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename } from "node:path";

import {
  loadConfig,
  loadEffectiveConfig,
  loadChannelBindings,
  saveChannelBinding,
  saveConfig,
  CONFIG_FILE,
  defaultConfigTemplate,
} from "./config.js";
import type { Config } from "./config.js";
import {
  makeChannelName,
  makeStaticChannelName,
  splitMessage,
  toolLabel,
  isAbortLikeError,
  sleep,
  withTimeout,
} from "./helpers.js";

// ─── Reconnection constants ──────────────────────────────────────────────────
const RECONNECT_BASE_DELAY_MS = 2_000;
const RECONNECT_MAX_DELAY_MS = 60_000;
const RECONNECT_MAX_ATTEMPTS = 10;

// ─── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  /** Mutable runtime state — never persisted to disk. */
  interface RuntimeState {
    /** The channel ID this session is listening on (created or fallback). */
    activeChannelId: string | null;
    /** Channel name at creation time (for display). */
    sessionChannelName: string | null;
  }

  let client: Client | null = null;
  let activeConfig: Config | null = null;
  const runtime: RuntimeState = { activeChannelId: null, sessionChannelName: null };

  let agentBusy = false;
  let pendingReplyChannelId: string | null = null;
  let pendingReplyUserId: string | null = null;
  let collectedAssistantText: string[] = [];
  let postedThinkingNotice = false;
  let lastImageArtifactPath: string | null = null;
  // Raw texts of prompts we injected from Discord, awaiting their message_end.
  // Used to keep echo from bouncing Discord-originated messages back to Discord.
  const injectedQueue: string[] = [];

  // ── Streaming reply state (stream: true) ─────────────────────────────
  // One Discord message edited in place as assistant text streams in.
  // A turn can produce several assistant messages (text, then tool calls,
  // then more text) — each streams separately, so segments are accumulated
  // per assistant message and joined for the buffer view.
  let streamBufferId: string | null = null;
  let streamText = "";
  let streamSegments: string[] = [];
  let streamSegmentId: string | null = null;
  let streamLastEditAt = 0;
  let streamEditTimer: ReturnType<typeof setTimeout> | null = null;
  const STREAM_EDIT_INTERVAL_MS = 1000;
  const STREAM_PREVIEW_MAX = 1900; // Discord message cap is 2000; leave headroom

  // Visual turn boundary in the channel. Unicode box-drawing horizontal line —
  // renders as a line unconditionally, unlike '---' which depends on Discord's
  // markdown parsing.
  const TURN_DIVIDER = "────────────────────";

  // ── Reconnection state ────────────────────────────────────────────────
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let isShuttingDown = false;
  let reconnectFailed = false;
  // Captured at connect time so reconnect can reuse them
  let connectNotify: ((msg: string, level: "success" | "error" | "warning" | "info") => void) | null = null;
  let connectSetStatus: ((key: string, val: string | undefined) => void) | null = null;

  // ── Question-answering state (for overriding ask_user_question) ────────
  let questionResolver: ((answer: string) => void) | null = null;
  let questionRejecter: ((reason: Error) => void) | null = null;
  let questionChannelId: string | null = null;
  let questionTimeout: ReturnType<typeof setTimeout> | null = null;
  let questionAbortListener: (() => void) | null = null;
  let questionAbortSignal: AbortSignal | null = null;

  // ── Subagent activity tracking (pi-subagents, optional) ──────────────
  // Discovered over the shared pi.events bus: pi-subagents broadcasts
  // `subagents:ready` on session start. If the plugin is not installed — or
  // excluded from this session — no events ever arrive and this feature
  // silently stays inert. Lifecycle events cover top-level agents only;
  // nested/workflow-owned children report through their parent.
  let subagentsAvailable = false;
  interface RunningSubagent {
    type?: string;
    description?: string;
  }
  const runningSubagents = new Map<string, RunningSubagent>();
  /** True once the "N subagents working" notice has been posted for the current streak. */
  let subagentNoticePosted = false;

  // Display name for a subagent: its short task description wins, falling
  // back to the agent type, then to a generic label.
  function subagentLabel(meta: RunningSubagent | undefined): string {
    const desc = meta?.description?.trim();
    if (desc) return desc.length > 80 ? desc.slice(0, 80) + "…" : desc;
    return meta?.type?.trim() || "subagent";
  }
  const subagentUnsubs: Array<() => void> = [];

  subagentUnsubs.push(
    pi.events.on("subagents:ready", () => {
      subagentsAvailable = true;
    }),
    pi.events.on("subagents:started", (event: any) => {
      if (event?.id) {
        runningSubagents.set(event.id, { type: event?.type, description: event?.description });
      }
    }),
    pi.events.on("subagents:completed", (event: any) => {
      void onSubagentSettled(event);
    }),
    pi.events.on("subagents:failed", (event: any) => {
      void onSubagentSettled(event);
    }),
    // Terminal event of a session: every agent has been stopped. Reset all
    // state so a later session_start in the same process starts clean.
    pi.events.on("subagents:disposed", () => {
      subagentsAvailable = false;
      runningSubagents.clear();
      subagentNoticePosted = false;
    }),
  );

  async function onSubagentSettled(event: any): Promise<void> {
    if (!event?.id) return;
    const meta = runningSubagents.get(event.id);
    // Unknown id — either never tracked or already settled. Ignore.
    if (!meta) return;
    runningSubagents.delete(event.id);
    // Only announce completions the user was set up to expect: if no
    // "working" notice went out, the agent finished before the turn ended
    // and its result is already in the reply.
    if (!subagentNoticePosted) return;
    if (runningSubagents.size > 0) {
      await sendToActiveChannel(
        `✅ Subagent finished: ${subagentLabel(meta)} (${runningSubagents.size} still working…)`,
      );
      return;
    }
    subagentNoticePosted = false;
    await sendToActiveChannel("✅ All subagents finished working.");
  }

  function clearQuestionState(): void {
    if (questionTimeout) {
      clearTimeout(questionTimeout);
      questionTimeout = null;
    }
    // Remove abort listener to prevent leak
    if (questionAbortListener && questionAbortSignal) {
      questionAbortSignal.removeEventListener("abort", questionAbortListener);
    }
    questionAbortListener = null;
    questionAbortSignal = null;
    questionResolver = null;
    questionRejecter = null;
    questionChannelId = null;
  }

  // ── Streaming reply helpers (stream: true) ─────────────────────────────

  // The live view is the tail of the accumulated text — Discord caps messages
  // at 2000 chars, so earlier prose is only in the final full post.
  function streamPreview(text: string): string {
    return text.length > STREAM_PREVIEW_MAX ? "…" + text.slice(-STREAM_PREVIEW_MAX) : text;
  }

  function resetStreamState(): void {
    if (streamEditTimer) {
      clearTimeout(streamEditTimer);
      streamEditTimer = null;
    }
    streamBufferId = null;
    streamText = "";
    streamSegments = [];
    streamSegmentId = null;
  }

  // Post the buffer message if it doesn't exist yet.
  async function ensureStreamBuffer(): Promise<void> {
    if (streamBufferId || !client) return;
    const channelId = mirrorTargetChannelId();
    if (!channelId) return;
    try {
      const channel = (await client.channels.fetch(channelId)) as TextChannel | null;
      if (!channel?.isTextBased()) return;
      const msg = await (channel as TextChannel).send(streamPreview(streamText) || "💭 _Thinking…_");
      streamBufferId = msg.id;
      streamLastEditAt = Date.now();
    } catch (err) {
      console.error("[pi-discord-remote] Failed to create stream buffer:", err);
    }
  }

  // Edit the buffer in place, throttled to respect Discord rate limits.
  // A trailing timer flushes the latest text if edits arrive faster than the
  // interval. Degrades gracefully: on failure the final full post still goes
  // out via the normal agent_end path.
  async function flushStreamEdit(force = false): Promise<void> {
    if (!streamBufferId || !client) return;
    const now = Date.now();
    if (!force && now - streamLastEditAt < STREAM_EDIT_INTERVAL_MS) {
      if (!streamEditTimer) {
        const wait = STREAM_EDIT_INTERVAL_MS - (now - streamLastEditAt);
        streamEditTimer = setTimeout(() => {
          streamEditTimer = null;
          void flushStreamEdit(true);
        }, wait);
      }
      return;
    }
    const bufferId = streamBufferId;
    try {
      const msg = await client.channels
        .fetch(mirrorTargetChannelId()!)
        .then((c) => (c as TextChannel).messages.fetch(bufferId));
      await msg.edit(streamPreview(streamText));
      streamLastEditAt = Date.now();
    } catch (err) {
      console.error("[pi-discord-remote] Stream edit failed:", err);
    }
  }

  // Delete the buffer when the run ends — the full reply is posted below it,
  // so keeping the tail preview would read as duplication.
  async function deleteStreamBuffer(bufferId: string): Promise<void> {
    if (!client) return;
    try {
      const channelId = mirrorTargetChannelId();
      if (!channelId) return;
      const channel = (await client.channels.fetch(channelId)) as TextChannel | null;
      if (channel?.isTextBased()) {
        await (channel as TextChannel).messages.delete(bufferId);
      }
    } catch (err) {
      console.error("[pi-discord-remote] Failed to delete stream buffer:", err);
    }
  }

  // ── Shared send helpers ──────────────────────────────────────────────────

  // Where activity should be mirrored right now: the channel that started the
  // current turn, or — when echo is enabled — the session channel for turns
  // typed in the pi terminal.
  function mirrorTargetChannelId(): string | null {
    return pendingReplyChannelId ?? (activeConfig?.echo ? runtime.activeChannelId : null);
  }

  async function sendToActiveChannel(text: string): Promise<void> {
    const channelId = mirrorTargetChannelId();
    if (!client || !channelId) return;
    try {
      const channel = (await client.channels.fetch(channelId)) as TextChannel | null;
      if (!channel?.isTextBased()) return;
      await (channel as TextChannel).send(text);
    } catch (err) {
      console.error("[pi-discord-remote] Failed to send message:", err);
    }
  }

  // Called at the end of each turn. Announces subagents still running in the
  // background (once per streak) so Discord users know the session isn't idle;
  // the matching "all finished" line is sent from onSubagentSettled.
  async function maybePostSubagentNotice(): Promise<void> {
    if (!subagentsAvailable || subagentNoticePosted || runningSubagents.size === 0) return;
    subagentNoticePosted = true;
    const n = runningSubagents.size;
    const MAX_LISTED = 10;
    const lines = [...runningSubagents.values()]
      .slice(0, MAX_LISTED)
      .map((meta) => `• ${subagentLabel(meta)}`);
    if (n > MAX_LISTED) lines.push(`• …and ${n - MAX_LISTED} more`);
    await sendToActiveChannel(
      `🤖 ${n} subagent${n === 1 ? "" : "s"} working…\n${lines.join("\n")}`,
    );
  }

  function getTargetChannelId(overrideChannelId?: string): string | null {
    const override = overrideChannelId?.trim();
    return override || runtime.activeChannelId || activeConfig?.channelId || pendingReplyChannelId || null;
  }

  async function sendMessageViaDiscordRest(params: {
    channelId: string;
    token: string;
    content?: string;
    filename?: string;
    mediaType?: string;
    bytes?: Buffer;
  }): Promise<{ ok: boolean; error?: string }> {
    const url = `https://discord.com/api/v10/channels/${params.channelId}/messages`;
    const form = new FormData();

    if (params.bytes) {
      const fileName = params.filename ?? "image.png";
      const type = params.mediaType ?? "image/png";
      const payload = {
        content: params.content ?? "",
        attachments: [{ id: 0, filename: fileName }],
      };
      form.append("payload_json", JSON.stringify(payload));
      form.append("files[0]", new Blob([new Uint8Array(params.bytes)], { type }), fileName);
    } else {
      form.append("content", params.content ?? "");
    }

    const resp = await withTimeout(
      fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bot ${params.token}`,
        },
        body: form,
      }),
      20_000,
      "discord_rest_send",
    );

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      if (resp.status === 404) return { ok: false, error: `unknown_channel:${params.channelId}` };
      return { ok: false, error: `discord_http_${resp.status}:${body.slice(0, 200)}` };
    }

    return { ok: true };
  }

  async function sendAttachmentToActiveChannel(params: {
    channelId?: string;
    path?: string;
    url?: string;
    base64?: string;
    mediaType?: string;
    filename?: string;
    caption?: string;
  }): Promise<{ ok: boolean; sentAs?: string; error?: string }> {
    const targetChannelId = getTargetChannelId(params.channelId);
    if (!client?.isReady()) {
      return { ok: false, error: "discord_not_connected" };
    }
    if (!targetChannelId) {
      return { ok: false, error: "no_active_channel" };
    }

    const sendOnce = async (): Promise<{ ok: boolean; sentAs?: string; error?: string }> => {
      const channel = (await withTimeout(
        client!.channels.fetch(targetChannelId),
        15_000,
        "fetch_channel",
      )) as TextChannel | null;
      if (!channel?.isTextBased()) return { ok: false, error: "channel_unavailable" };
      if (activeConfig?.guildId && "guildId" in channel && channel.guildId !== activeConfig.guildId) {
        return { ok: false, error: `wrong_guild:${targetChannelId}` };
      }

      const content = params.caption?.trim() || undefined;
      const token = activeConfig?.token?.trim();
      if (!token) return { ok: false, error: "missing_bot_token" };

      if (params.path) {
        const filePath = params.path.trim();
        if (!existsSync(filePath)) return { ok: false, error: `file_not_found:${filePath}` };
        const buffer = await withTimeout(readFile(filePath), 5_000, "read_file");
        const name = params.filename?.trim() || basename(filePath);
        const sent = await sendMessageViaDiscordRest({
          channelId: targetChannelId,
          token,
          content,
          filename: name,
          mediaType: "image/png",
          bytes: buffer,
        });
        if (!sent.ok) return { ok: false, error: sent.error ?? "send_path_failed" };
        return { ok: true, sentAs: "path" };
      }

      if (params.url) {
        const body = content ? `${content}\n${params.url.trim()}` : params.url.trim();
        const sent = await sendMessageViaDiscordRest({
          channelId: targetChannelId,
          token,
          content: body,
        });
        if (!sent.ok) return { ok: false, error: sent.error ?? "send_url_failed" };
        return { ok: true, sentAs: "url" };
      }

      if (params.base64) {
        const mediaType = params.mediaType?.trim() || "image/png";
        const ext = mediaType.split("/")[1] ?? "png";
        const buffer = Buffer.from(params.base64.trim(), "base64");
        const name = params.filename?.trim() || `image.${ext}`;
        const sent = await sendMessageViaDiscordRest({
          channelId: targetChannelId,
          token,
          content,
          filename: name,
          mediaType,
          bytes: buffer,
        });
        if (!sent.ok) return { ok: false, error: sent.error ?? "send_base64_failed" };
        return { ok: true, sentAs: "base64" };
      }

      return { ok: false, error: "missing_source" };
    };

    const toError = (err: any): string => {
      const msg = String(err?.message ?? "send_failed");
      const code = String(err?.code ?? "");
      if (code === "10003" || msg.toLowerCase().includes("unknown channel")) {
        return `unknown_channel:${targetChannelId}`;
      }
      return msg;
    };

    try {
      return await sendOnce();
    } catch (err: any) {
      if (isAbortLikeError(err)) {
        try {
          await sleep(300);
          return await sendOnce();
        } catch (retryErr: any) {
          return { ok: false, error: toError(retryErr) };
        }
      }
      return { ok: false, error: toError(err) };
    }
  }

  // ── Collect assistant output ──────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pi.on("agent_start", async (_event: any) => {
    agentBusy = true;
    collectedAssistantText = [];
    postedThinkingNotice = false;
    lastImageArtifactPath = null;
    resetStreamState();
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pi.on("tool_result", async (event: any) => {
    // Capture latest browser image artifact path for follow-up discord_send_image calls.
    if (event.toolName === "agent_browser") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const artifacts: any[] = event.details?.artifacts ?? [];
      for (const artifact of artifacts) {
        if (artifact?.kind === "image") {
          const candidate = artifact.absolutePath ?? artifact.path;
          if (candidate && existsSync(candidate)) {
            lastImageArtifactPath = candidate;
          }
        }
      }
    }

    if (!pendingReplyChannelId) {
      return;
    }

    // Only send text summaries if toolResponses is enabled
    if (!activeConfig?.toolResponses) return;

    // Build a label like "↩️ bash: ..." or "↩️ read: ..."
    const emoji = event.isError ? "❌" : "↩️";
    const detailLabel = event.content
      ?.filter((c: any) => c.type === "text")
      .map((c: any) => String(c.text ?? "").trim())
      .join("")
      .slice(0, 300) ?? "";

    // Send a compact summary line for each tool result
    const label = `${emoji} _${event.toolName}_`;
    if (detailLabel) {
      const truncated = detailLabel.length > 400 ? detailLabel.slice(0, 400) + "…" : detailLabel;
      await sendToActiveChannel(`${label}:\n\`\`\`\n${truncated}\n\`\`\``);
    } else {
      await sendToActiveChannel(label);
    }
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pi.on("message_update", async (event: any) => {
    if (!mirrorTargetChannelId()) return;
    if (event.message.role !== "assistant") return;

    // Streaming mode: track the accumulated assistant text and edit the
    // buffer message in place (throttled). The buffer doubles as the
    // thinking indicator, so the 💭 notice is skipped.
    if (activeConfig?.stream) {
      const text = (event.message.content as Array<any>)
        .filter((c: any) => c.type === "text" && typeof c.text === "string")
        .map((c: any) => c.text as string)
        .join("");
      if (text.trim()) {
        // Track which assistant message is streaming; a new one (e.g. after a
        // tool call) starts a new segment instead of replacing the buffer.
        const msgId = (event.message as { id?: string }).id ?? null;
        const isNewSegment =
          streamSegments.length === 0 ||
          (msgId
            ? msgId !== streamSegmentId
            : text.length < streamSegments[streamSegments.length - 1].length);
        if (isNewSegment) {
          streamSegments.push("");
          streamSegmentId = msgId;
        }
        streamSegments[streamSegments.length - 1] = text;
        streamText = streamSegments.filter((s) => s.trim()).join("\n\n");
        await ensureStreamBuffer();
        await flushStreamEdit();
      }
      return;
    }

    if (postedThinkingNotice) return;
    const hasThinking = (event.message.content as Array<{ type: string }>)
      .some((c) => c.type === "thinking");
    if (hasThinking) {
      postedThinkingNotice = true;
      await sendToActiveChannel("💭 _Thinking…_");
    }
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pi.on("tool_execution_start", async (event: any) => {
    if (!pendingReplyChannelId) return;
    // discord_ask_user_question is handled by our tool (formatted output)
    if (event.toolName === "discord_ask_user_question") return;
    await sendToActiveChannel(toolLabel(event.toolName, event.args));
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pi.on("message_end", async (event: any) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const content = event.message.content as Array<any>;

    if (event.message.role === "user") {
      const text = content
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text as string)
        .join("");
      if (!text.trim()) return;
      // A prompt we injected from Discord — consume it so echo doesn't bounce
      // it back into the channel it came from.
      if (injectedQueue.length && injectedQueue[0] === text) {
        injectedQueue.shift();
        return;
      }
      // A prompt typed in the pi terminal — mirror it when echo is enabled.
      if (activeConfig?.echo && client && runtime.activeChannelId) {
        try {
          const channel = (await client.channels.fetch(runtime.activeChannelId)) as TextChannel | null;
          if (channel?.isTextBased()) {
            const prefix = "🖥️ **You** (terminal): ";
            const chunks = splitMessage(prefix + text);
            chunks[chunks.length - 1] += "\n\n" + TURN_DIVIDER;
            for (const chunk of chunks) {
              await (channel as TextChannel).send(chunk);
            }
          }
        } catch (err) {
          console.error("[pi-discord-remote] Failed to echo user message:", err);
        }
      }
      return;
    }

    // Collect text from assistant messages
    if (event.message.role === "assistant") {
      const text = content
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text as string)
        .join("");
      if (text.trim()) collectedAssistantText.push(text);
    }
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pi.on("agent_end", async (_event: any) => {
    // agentBusy stays true here — steering or follow-up work can start another
    // run right after agent_end. It is released by agent_settled.
    const streamBufferToDelete = streamBufferId;
    resetStreamState();

    const targetChannelId = mirrorTargetChannelId();
    if (!targetChannelId || !client) {
      pendingReplyChannelId = null;
      pendingReplyUserId = null;
      collectedAssistantText = [];
      return;
    }

    const text = collectedAssistantText.join("\n\n").trim();
    // Clear state before sending so sendToActiveChannel still sees the channel ID
    collectedAssistantText = [];
    // pendingReplyChannelId cleared after send below

    if (!text) {
      await maybePostSubagentNotice();
      pendingReplyChannelId = null;
      pendingReplyUserId = null;
      return;
    }

    const chunks = splitMessage(text);
    // Prepend a mention to the last chunk so the sender is notified when work is done
    const mention = pendingReplyUserId ? `<@${pendingReplyUserId}> ` : "";
    const lastIdx = chunks.length - 1;
    chunks[lastIdx] = mention + chunks[lastIdx] + "\n\n" + TURN_DIVIDER;

    for (const chunk of chunks) {
      await sendToActiveChannel(chunk);
    }
    // Replace the live buffer with the complete reply.
    if (streamBufferToDelete) {
      await deleteStreamBuffer(streamBufferToDelete);
    }
    await maybePostSubagentNotice();
    pendingReplyChannelId = null;
    pendingReplyUserId = null;
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pi.on("agent_settled", async (_event: any) => {
    // No remaining automatic work (runs, retries, steering, follow-ups) —
    // the session is truly idle and new Discord messages start fresh turns.
    agentBusy = false;
  });

  // ── Auto-connect on new/resumed sessions (per-project opt-in) ────────
  // Fires when a session starts. Only "new" and "resume" are auto-connected
  // (when the project opts in via .pi/discord-remote.json with
  // { "autoStart": true }); "reload" keeps the existing client —
  // session_shutdown deliberately preserves it across reloads.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pi.on("session_start", async (event: any, ctx: any) => {
    if (event?.reason !== "new" && event?.reason !== "resume") return;
    if (client) return;
    const cfg = await loadEffectiveConfig(ctx?.cwd);
    if (!cfg?.autoStart) return;
    await startClient(
      cfg,
      ctx?.cwd ?? process.cwd(),
      (msg, level) => ctx.ui.notify(msg, level),
      (key, val) => ctx.ui.setStatus(key, val),
    );
  });

  // ── Cleanup helper ───────────────────────────────────────────────────────

  async function deleteSessionChannel(
    setStatusFn: (key: string, val: string | undefined) => void,
  ): Promise<void> {
    if (!client || !runtime.activeChannelId) return;

    if (activeConfig?.staticChannel) {
      // Static channel: preserve history. Post a closing notice, then deny
      // SendMessages to @everyone (the everyone-role id equals the guild id),
      // making the channel read-only until a new session adopts it.
      // The project→channel binding is kept, so the next session in this
      // project reuses this exact channel.
      try {
        const channel = (await client.channels.fetch(runtime.activeChannelId)) as TextChannel | null;
        if (channel?.isTextBased()) {
          await (channel as TextChannel).send(
            "🔒 _Session ended — this channel is now read-only. History is preserved; " +
              "starting a session in this project again will reopen it._",
          );
          await (channel as TextChannel).permissionOverwrites
            .edit((channel as TextChannel).guildId, { SendMessages: false })
            .catch(() => {});
        }
      } catch (err) {
        console.error("[pi-discord-remote] Failed to lock static channel:", err);
      }
      runtime.activeChannelId = null;
      runtime.sessionChannelName = null;
      setStatusFn("pi-discord-remote", undefined);
      return;
    }

    try {
      const channel = (await client.channels.fetch(runtime.activeChannelId)) as TextChannel | null;
      if (channel) await channel.delete("Pi session ended");
    } catch (err) {
      console.error("[pi-discord-remote] Failed to delete channel:", err);
    }
    runtime.activeChannelId = null;
    runtime.sessionChannelName = null;
    setStatusFn("pi-discord-remote", undefined);
  }

  // ── Reconnect logic ────────────────────────────────────────────────────────

  function clearReconnectTimer(): void {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function scheduleReconnect(): void {
    clearReconnectTimer();
    reconnectAttempt++;

    if (reconnectAttempt > RECONNECT_MAX_ATTEMPTS) {
      console.error(
        `[pi-discord-remote] Max reconnect attempts (${RECONNECT_MAX_ATTEMPTS}) reached. Giving up.`,
      );
      reconnectFailed = true;
      connectNotify?.(
        `❌ Discord reconnect failed after ${RECONNECT_MAX_ATTEMPTS} attempts. Run /pi-discord-remote start to retry.`,
        "error",
      );
      connectSetStatus?.("pi-discord-remote", "❌ Discord: reconnect failed");
      return;
    }

    // Exponential backoff with jitter: 2s, 4s, 8s, 16s, … up to 60s
    const baseDelay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** (reconnectAttempt - 1), RECONNECT_MAX_DELAY_MS);
    const jitter = Math.random() * 1_000;
    const delay = baseDelay + jitter;

    console.log(
      `[pi-discord-remote] Reconnect attempt ${reconnectAttempt}/${RECONNECT_MAX_ATTEMPTS} in ${Math.round(delay)}ms`,
    );
    connectSetStatus?.("pi-discord-remote", `🔄 Discord: reconnecting (${reconnectAttempt}/${RECONNECT_MAX_ATTEMPTS})…`);

    reconnectTimer = setTimeout(async () => {
      if (isShuttingDown) return;
      await attemptReconnect();
    }, delay);
  }

  async function attemptReconnect(): Promise<void> {
    if (!activeConfig) return;

    // Destroy the old client if it still exists
    if (client) {
      await client.destroy().catch(() => {});
      client = null;
    }

    const cfg = activeConfig;
    const notify = connectNotify ?? ((_m: string, _l: any) => {});
    const setStatus = connectSetStatus ?? ((_k: string, _v: any) => {});

    console.log("[pi-discord-remote] Reconnecting to Discord…");

    client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel, Partials.Message],
    });

    client.on("messageCreate", buildMessageHandler());
    client.on("error", (err) => {
      console.error("[pi-discord-remote] Discord client error:", err);
      setStatus("pi-discord-remote", "⚠️ Discord: error");
    });
    client.on("shardDisconnect", () => {
      if (isShuttingDown) return;
      console.error("[pi-discord-remote] Discord WebSocket disconnected during reconnect, retrying…");
      setStatus("pi-discord-remote", "🔄 Discord: reconnecting…");
      scheduleReconnect();
    });

    try {
      await client.login(cfg.token);
      // Wait for ready
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("ready timeout")), 30_000);
        client!.once("ready", () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      // Successfully reconnected — restore channel reference
      reconnectAttempt = 0;
      const channelLabel = runtime.sessionChannelName ?? runtime.activeChannelId ?? "unknown";
      console.log(`[pi-discord-remote] Reconnected successfully → #${channelLabel}`);
      notify(`✅ Discord reconnected → #${channelLabel}`, "success");
      setStatus("pi-discord-remote", `🔌 Discord: #${channelLabel}`);

      // Post a notice in the channel so the user knows we're back
      if (runtime.activeChannelId) {
        try {
          const ch = (await client.channels.fetch(runtime.activeChannelId)) as TextChannel | null;
          if (ch?.isTextBased()) {
            await ch.send("🔌 _Reconnected — ready for commands._").catch(() => {});
          }
        } catch {
          // Channel may have been deleted — that's fine
        }
      }
    } catch (err: any) {
      console.error("[pi-discord-remote] Reconnect failed:", err.message);
      scheduleReconnect();
    }
  }

  function buildMessageHandler() {
    return async (message: Message) => {
      if (!activeConfig) return;
      if (message.author.bot) return;
      if (message.channelId !== runtime.activeChannelId) return;

      if (
        activeConfig.allowedUserIds?.length &&
        !activeConfig.allowedUserIds.includes(message.author.id)
      ) {
        await message.reply("❌ Your user ID is not on the allow-list.").catch(() => {});
        return;
      }

      // If waiting for a question answer, route this message to the resolver
      if (questionResolver && message.channelId === questionChannelId) {
        if (activeConfig.reactions !== false) {
          await message.react("✅").catch(() => {});
        }
        const resolve = questionResolver;
        resolve(message.content);
        return;
      }

      // Attribute the prompt to its Discord author so the agent knows who is driving.
      // displayNames wins: a string overrides the name, null marks the default
      // user whose messages get no [Name]: prefix. Otherwise fall back to
      // server nickname, global display name, and finally the @username handle.
      const displayName = activeConfig?.displayNames?.[message.author.id];
      const authorName =
        displayName === null
          ? null
          : displayName ??
            message.member?.displayName ??
            message.author.displayName ??
            message.author.username;
      const injected = authorName === null ? message.content : `[${authorName}]: ${message.content}`;

      if (agentBusy) {
        if (activeConfig.steer) {
          // Steering: inject into the running turn. The message is delivered
          // after the current assistant turn finishes its tool calls, before
          // the next LLM call — the agent sees it immediately at its next step.
          if (activeConfig.reactions !== false) {
            await message.react("⏩").catch(() => {});
          }
          injectedQueue.push(injected);
          pi.sendUserMessage(injected, { deliverAs: "steer" });
        } else {
          await message.reply("⏳ Still processing the previous message — please wait.").catch(() => {});
        }
        return;
      }

      if (activeConfig.reactions !== false) {
        await message.react("⏳").catch(() => {});
      }

      pendingReplyChannelId = message.channelId;
      pendingReplyUserId = message.author.id;
      collectedAssistantText = [];
      injectedQueue.push(injected);
      pi.sendUserMessage(injected);
    };
  }

  // ── Session cleanup ───────────────────────────────────────────────────────

  pi.on("session_shutdown", async (event: any) => {
    // Reject any pending question so tool execution doesn't hang
    if (questionRejecter) {
      questionRejecter(new Error("Session shut down"));
    }
    clearQuestionState();
    // Drop pi.events bus subscriptions so a reloaded copy of this extension
    // doesn't accumulate stale handlers on the shared bus.
    for (const unsub of subagentUnsubs.splice(0)) unsub();
    clearReconnectTimer();
    isShuttingDown = true;
    // Don't destroy Discord client on reload — just re-register handlers
    if (event?.reason === "reload") {
      isShuttingDown = false;
      return;
    }
    if (client) {
      await deleteSessionChannel((_k, _v) => {});
      await client.destroy().catch(() => {});
      client = null;
      activeConfig = null;
      runtime.activeChannelId = null;
      runtime.sessionChannelName = null;
    }
  });

  // Auto-connect removed — user must run /pi-discord-remote start explicitly.

  // ── Connect + channel-create helper ──────────────────────────────────────

  async function startClient(
    cfg: Config,
    cwd: string,
    notifyFn: (msg: string, level: "success" | "error" | "warning" | "info") => void,
    setStatusFn: (key: string, val: string | undefined) => void,
  ): Promise<void> {
    if (client) {
      notifyFn("Already connected to Discord.", "warning");
      return;
    }

    activeConfig = cfg;
    isShuttingDown = false;
    reconnectAttempt = 0;
    reconnectFailed = false;
    clearReconnectTimer();

    // Capture closures for reconnect reuse
    connectNotify = notifyFn;
    connectSetStatus = setStatusFn;

    client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel, Partials.Message],
    });

    client.on("messageCreate", buildMessageHandler());

    // ── Reconnection handling (for post-connect disconnects only) ──────
    client.on("error", (err) => {
      console.error("[pi-discord-remote] Discord client error:", err);
      setStatusFn("pi-discord-remote", "⚠️ Discord: error");
    });

    client.on("shardDisconnect", () => {
      if (isShuttingDown) return;
      console.error("[pi-discord-remote] Discord WebSocket disconnected, starting reconnect…");
      setStatusFn("pi-discord-remote", "🔄 Discord: reconnecting…");
      scheduleReconnect();
    });

    // ── Await login + ready so we can surface immediate errors ─────────
    // Register the ready listener BEFORE login to avoid a race window
    // where ready fires before the Promise is constructed.
    const readyPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("ready timeout (30s)")), 30_000);
      client!.once("ready", async (c) => {
        clearTimeout(timeout);
        // Channel creation/adoption happens inside this single ready handler
        // An explicit channelName is honored on its own — no date suffix,
        // whether or not staticChannel is set. Without it, static channels
        // use the project slug and per-session channels get the date suffix.
        const channelName =
          (cfg.channelName?.trim() || cfg.staticChannel)
            ? makeStaticChannelName(cwd, cfg.channelName)
            : makeChannelName(cwd);
        try {
          const guild = await c.guilds.fetch(cfg.guildId);
          let channel: TextChannel | null = null;
          let resumed = false;

          if (cfg.staticChannel) {
            // Reuse an existing channel when possible: first the persisted
            // binding for this project, then a name search in the guild.
            // (The everyone-role id equals the guild id, so a send-deny
            // overwrite set at lock time is what makes a found channel
            // read-only; it is cleared below on adoption.)
            const bound = (await loadChannelBindings())[cwd];
            if (bound) {
              try {
                const fetched = (await c.channels.fetch(bound.channelId)) as TextChannel | null;
                if (
                  fetched?.isTextBased() &&
                  "guildId" in fetched &&
                  fetched.guildId === cfg.guildId
                ) {
                  channel = fetched as TextChannel;
                }
                // Stale binding (channel deleted or moved) — fall through to
                // the name search, which rebinds on adoption/create.
              } catch {
                // Fetch failed — fall through to the name search.
              }
            }
            if (!channel) {
              const all = await guild.channels.fetch();
              const match = all.find(
                (ch): ch is TextChannel =>
                  !!ch &&
                  ch.type === ChannelType.GuildText &&
                  ch.name.toLowerCase() === channelName,
              );
              channel = match ?? null;
            }
          }

          if (channel) {
            // Adopt a static channel: reopen it and say so. The binding
            // identifies the channel (ID — unique, rename-proof); the config
            // names it. If the current name drifted — channelName changed,
            // or someone renamed the channel in Discord — rename it back so
            // the declared name wins and history stays in one place.
            resumed = true;
            if (channel.name.toLowerCase() !== channelName.toLowerCase()) {
              try {
                await channel.edit({ name: channelName });
                console.log(
                  `[pi-discord-remote] Renamed static channel #${channel.name} → #${channelName}`,
                );
              } catch (err) {
                console.error("[pi-discord-remote] Failed to rename static channel:", err);
              }
            }
            try {
              await channel.permissionOverwrites.edit(channel.guildId, { SendMessages: null });
            } catch (err) {
              console.error("[pi-discord-remote] Failed to unlock static channel:", err);
            }
            runtime.activeChannelId = channel.id;
            runtime.sessionChannelName = channelName;
            await saveChannelBinding(cwd, { channelId: channel.id, channelName });
            try {
              await channel.send("🔓 _Session started — this channel is live again._");
            } catch {
              // Non-fatal — the channel works even if the notice fails.
            }
          } else {
            const newChannel = await guild.channels.create({
              name: channelName,
              type: ChannelType.GuildText,
              ...(cfg.categoryId ? { parent: cfg.categoryId } : {}),
              topic: `Pi session — ${cwd}`,
            });
            runtime.activeChannelId = newChannel.id;
            runtime.sessionChannelName = channelName;
            if (cfg.staticChannel) {
              await saveChannelBinding(cwd, { channelId: newChannel.id, channelName });
            }
          }

          const label = `🔌 Discord: #${runtime.sessionChannelName ?? channelName}`;
          notifyFn(
            resumed
              ? `Reusing #${runtime.sessionChannelName} (static channel)`
              : `Connected as ${c.user.tag} → #${channelName}`,
            "success",
          );
          setStatusFn("pi-discord-remote", label);
        } catch (err) {
          // Channel creation failed — fall back to configured channelId
          console.error("[pi-discord-remote] Could not create channel:", err);
          notifyFn(
            `⚠️ Could not create channel (check Manage Channels permission). Falling back to configured channelId.`,
            "warning",
          );
          runtime.activeChannelId = cfg.channelId ?? null;
          setStatusFn("pi-discord-remote", `🔌 Discord: ${c.user.tag} (fallback)`);
        }
        resolve();
      });
    });

    try {
      setStatusFn("pi-discord-remote", "🔌 Discord: connecting…");
      await client.login(cfg.token);
      await readyPromise;
    } catch (err: any) {
      // Initial login failure — clean up and notify immediately
      console.error("[pi-discord-remote] Initial login failed:", err.message);
      await client.destroy().catch(() => {});
      client = null;
      activeConfig = null;
      connectNotify = null;
      connectSetStatus = null;
      notifyFn(`❌ Failed to connect: ${err.message}`, "error");
      setStatusFn("pi-discord-remote", undefined);
    }
  }

  // ── Intercept ask_user_question → redirect to Discord version ─────────

  // When Discord is connected, block the original ask_user_question (TUI-only)
  // and tell the LLM to use discord_ask_user_question instead.
  // When Discord is not connected, let the original tool through as fallback.
  pi.on("tool_call", async (event, _ctx) => {
    if (event.toolName !== "ask_user_question") return;
    if (!client?.isReady()) return; // Discord not ready — let TUI tool work
    return { block: true, reason: "Discord is connected — use discord_ask_user_question instead." };
  });

  // ── System prompt hint: prefer Discord version when connected ──────────

  pi.on("before_agent_start", async (event, _ctx) => {
    if (!client?.isReady()) return;
    const activeChannelId = runtime.activeChannelId ?? activeConfig?.channelId;
    return {
      systemPrompt:
        event.systemPrompt +
        "\n\n" +
        (activeChannelId
          ? `Active Discord session channel ID: ${activeChannelId}. ` +
            "When using discord_send_image, pass this as channelId.\n\n"
          : "") +
        "When you need to ask the user a clarifying question, use the " +
        "discord_ask_user_question tool instead of ask_user_question. " +
        "The Discord version sends questions to the user's Discord channel. " +
        "If discord_ask_user_question returns an error about no UI, " +
        "fall back to ask_user_question.",
    };
  });

  // ── Tool: discord_ask_user_question → Discord ───────────────────────────

  // Send questions to Discord — avoids the TUI-only dialog from
  // @juicesharp/rpiv-ask-user-question that remote users can't see.
  // When Discord is connected, use this tool instead of ask_user_question.
  pi.registerTool({
    name: "discord_ask_user_question",
    label: "Ask User Question (Discord)",
    description:
      "Ask the user one or more structured clarifying questions via Discord. " +
      "Use this instead of ask_user_question when Discord is connected. " +
      "Questions and options are forwarded to the Discord channel. " +
      "The user replies with the option number, label, or custom text.",
    parameters: Type.Object({
      questions: Type.Array(
        Type.Object({
          question: Type.String(),
          header: Type.String(),
          options: Type.Array(
            Type.Object({
              label: Type.String(),
              description: Type.String(),
              preview: Type.Optional(Type.String()),
            }),
          ),
          multiSelect: Type.Optional(Type.Boolean()),
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const channelId = pendingReplyChannelId;
      if (!client || !channelId) {
        return {
          content: [
            {
              type: "text",
              text: "Discord not connected. Please answer in the Pi TUI directly.",
            },
          ],
          details: { answers: [], cancelled: true, error: "no_ui" },
        };
      }

      let channel: TextChannel | null = null;
      try {
        const fetched = await client.channels.fetch(channelId);
        if (fetched?.isTextBased()) channel = fetched as TextChannel;
      } catch {
        // channel fetch failed — fall through
      }
      if (!channel) {
        return {
          content: [
            {
              type: "text",
              text: "Discord channel not available. Use ask_user_question instead for TUI-based questions, or connect Discord first.",
            },
          ],
          details: { answers: [], cancelled: true, error: "no_ui" },
        };
      }

      interface Answer {
        questionIndex: number;
        question: string;
        kind: "option" | "custom" | "chat" | "multi";
        answer: string | null;
        selected?: string[];
        notes?: string;
        preview?: string;
      }

      const answers: Answer[] = [];

      for (let qi = 0; qi < params.questions.length; qi++) {
        const q = params.questions[qi];

        // Format question for Discord
        const lines: string[] = [];
        lines.push(`## ${q.header}: ${q.question}`);
        lines.push("");

        if (q.multiSelect) {
          lines.push("*(Multi-select — reply with numbers/labels separated by commas)*");
          lines.push("");
        }

        for (let oi = 0; oi < q.options.length; oi++) {
          const opt = q.options[oi];
          lines.push(`${oi + 1}. **${opt.label}** — ${opt.description}`);
          if (opt.preview) {
            lines.push(`\`\`\`\n${opt.preview}\n\`\`\``);
          }
        }

        lines.push("");
        if (q.multiSelect) {
          lines.push("> Reply with numbers/labels (e.g. \"1,3\") or type \"chat\" to skip.");
        } else {
          lines.push("> Reply with the number or label, type a custom answer, or type \"chat\" to skip.");
        }

        // Send the question
        try {
          await channel.send(lines.join("\n"));
        } catch {
          return {
            content: [{ type: "text", text: "Failed to send question to Discord." }],
            details: { answers: [], cancelled: true, error: "no_ui" },
          };
        }

        // Wait for answer
        questionChannelId = channelId;
        let answerText: string;
        try {
          answerText = await new Promise<string>((resolve, reject) => {
            questionResolver = resolve;
            questionRejecter = reject;

            questionTimeout = setTimeout(() => {
              clearQuestionState();
              reject(new Error("Question timed out — no response in 5 minutes"));
            }, 300_000);

            const onAbort = () => {
              clearQuestionState();
              reject(new Error("Session shut down while waiting for question answer"));
            };
            if (signal) {
              if (signal.aborted) {
                onAbort();
                return;
              }
              questionAbortListener = onAbort;
              questionAbortSignal = signal;
              signal.addEventListener("abort", onAbort, { once: true });
            }
          });
        } catch (err: any) {
          clearQuestionState();
          return {
            content: [{ type: "text", text: `Question cancelled: ${err.message}` }],
            details: { answers, cancelled: true },
          };
        }
        clearQuestionState();

        const trimmed = answerText.trim();

        // Check for "chat" escape
        if (trimmed.toLowerCase() === "chat" || trimmed.toLowerCase() === "/chat") {
          answers.push({
            questionIndex: qi,
            question: q.question,
            kind: "chat",
            answer: null,
          });
          continue;
        }

        // Parse answer
        if (q.multiSelect) {
          // Multi-select: try to parse numbers/labels
          const parts = trimmed.split(/[,\s]+/).filter(Boolean);
          const selected: string[] = [];
          for (const part of parts) {
            const num = parseInt(part, 10);
            if (!isNaN(num) && num >= 1 && num <= q.options.length) {
              selected.push(q.options[num - 1].label);
            } else {
              // Try label match
              const match = q.options.find(
                (o: any) => o.label.toLowerCase() === part.toLowerCase(),
              );
              if (match) {
                if (!selected.includes(match.label)) selected.push(match.label);
              }
            }
          }

          if (selected.length > 0) {
            answers.push({
              questionIndex: qi,
              question: q.question,
              kind: "multi",
              answer: selected.join(", "),
              selected,
            });
          } else {
            // No match — treat as custom
            answers.push({
              questionIndex: qi,
              question: q.question,
              kind: "custom",
              answer: trimmed,
            });
          }
        } else {
          // Single-select: try number first, then label match, then custom
          const num = parseInt(trimmed, 10);
          if (!isNaN(num) && num >= 1 && num <= q.options.length) {
            const opt = q.options[num - 1];
            answers.push({
              questionIndex: qi,
              question: q.question,
              kind: "option",
              answer: opt.label,
              preview: opt.preview,
            });
          } else {
            const match = q.options.find(
              (o: any) => o.label.toLowerCase() === trimmed.toLowerCase(),
            );
            if (match) {
              answers.push({
                questionIndex: qi,
                question: q.question,
                kind: "option",
                answer: match.label,
                preview: match.preview,
              });
            } else {
              // Custom answer
              answers.push({
                questionIndex: qi,
                question: q.question,
                kind: "custom",
                answer: trimmed,
              });
            }
          }
        }
      }

      const summary = answers
        .map((a) => {
          if (a.kind === "chat") return `Q${a.questionIndex + 1}: [chat]`;
          if (a.kind === "multi") return `Q${a.questionIndex + 1}: ${a.selected?.join(", ")}`;
          return `Q${a.questionIndex + 1}: ${a.answer}`;
        })
        .join("; ");

      return {
        content: [{ type: "text", text: `User answers: ${summary}` }],
        details: { answers, cancelled: false },
      };
    },
  });

  // ── Tool: discord_send_image (opt-in; no automatic forwarding) ──────────
  pi.registerTool({
    name: "discord_send_image",
    label: "Send Image To Discord",
    description:
      "Send a single image to the active Discord session channel. " +
      "Use only when the user explicitly asks to send an image. " +
      "Provide exactly one source: local file path, URL, or base64.",
    parameters: Type.Object({
      channelId: Type.Optional(Type.String()),
      path: Type.Optional(Type.String()),
      url: Type.Optional(Type.String()),
      base64: Type.Optional(Type.String()),
      mediaType: Type.Optional(Type.String()),
      filename: Type.Optional(Type.String()),
      caption: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      const normalized = { ...params };
      let provided = [normalized.path, normalized.url, normalized.base64].filter(Boolean).length;
      if (provided === 0 && lastImageArtifactPath) {
        normalized.path = lastImageArtifactPath;
        provided = 1;
      }

      if (provided !== 1) {
        return {
          content: [{ type: "text", text: "Provide exactly one image source: path, url, or base64." }],
          details: { ok: false, error: "invalid_source_count" },
        };
      }

      let result: { ok: boolean; sentAs?: string; error?: string };
      try {
        result = await withTimeout(
          sendAttachmentToActiveChannel(normalized),
          30_000,
          "discord_send_image_total",
        );
      } catch (err: any) {
        const msg = String(err?.message ?? "send_failed");
        result = { ok: false, error: msg };
      }
      if (!result.ok) {
        return {
          content: [{ type: "text", text: `Failed to send image to Discord: ${result.error}` }],
          details: result,
        };
      }

      return {
        content: [{ type: "text", text: `Image sent to Discord (${result.sentAs}).` }],
        details: result,
      };
    },
  });

  // ── Command ───────────────────────────────────────────────────────────────

  pi.registerCommand("pi-discord-remote", {
    description: "Control this Pi session from Discord (creates a new channel per session)",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: async (args: any, ctx: any) => {
      const parts = (args ?? "").trim().split(/\s+/);
      const cmd = parts[0] || "help";

      switch (cmd) {
        // ── setup ─────────────────────────────────────────────────────────
        case "setup": {
          const existing = await loadConfig();

          const token = await ctx.ui.input("Discord Bot Token:", existing?.token ?? "");
          if (!token) return;

          const guildId = await ctx.ui.input(
            "Guild (Server) ID:",
            existing?.guildId ?? "",
          );
          if (!guildId) return;

          const categoryId = await ctx.ui.input(
            "Category ID for new channels (leave empty = server root):",
            existing?.categoryId ?? "",
          );

          const allowedRaw = await ctx.ui.input(
            "Allowed Discord user IDs (comma-separated, leave empty = allow all):",
            existing?.allowedUserIds?.join(", ") ?? "",
          );
          const allowedUserIds = allowedRaw
            ? allowedRaw.split(",").map((s: string) => s.trim()).filter(Boolean)
            : undefined;

          const toolResponsesRaw = await ctx.ui.input(
            "Send tool responses to Discord? (yes/no, default: no):",
            existing?.toolResponses ? "yes" : "no",
          );
          const toolResponses = toolResponsesRaw?.trim().toLowerCase() === "yes";

          const cfg: Config = {
            token,
            guildId,
            ...(categoryId ? { categoryId } : {}),
            ...(allowedUserIds ? { allowedUserIds } : {}),
            reactions: true,
            toolResponses,
          };

          await saveConfig(cfg);
          ctx.ui.notify(`Config saved → ${CONFIG_FILE}`, "success");
          break;
        }

        // ── start ─────────────────────────────────────────────────────────
        case "start": {
          // Project overrides (.pi/discord-remote.json) win over the global
          // config — autoStart is the usual per-project key, but a project
          // can also pin its own categoryId/guildId here.
          const cfg = await loadEffectiveConfig(ctx.cwd);
          if (!cfg) {
            ctx.ui.notify("No config found. Run /pi-discord-remote setup first.", "error");
            return;
          }
          await startClient(
            cfg,
            ctx.cwd,
            (msg, level) => ctx.ui.notify(msg, level),
            (key, val) => ctx.ui.setStatus(key, val),
          );
          break;
        }

        // ── stop ──────────────────────────────────────────────────────────
        case "stop": {
          if (!client) {
            ctx.ui.notify("Not connected.", "warning");
            return;
          }
          isShuttingDown = true;
          clearReconnectTimer();
          reconnectAttempt = 0;
          reconnectFailed = false;
          await deleteSessionChannel((key, val) => ctx.ui.setStatus(key, val));
          await client.destroy().catch(() => {});
          client = null;
          activeConfig = null;
          runtime.activeChannelId = null;
          runtime.sessionChannelName = null;
          connectNotify = null;
          connectSetStatus = null;
          ctx.ui.notify("Disconnected from Discord. Channel deleted.", "info");
          break;
        }

        // ── status ────────────────────────────────────────────────────────
        case "status": {
          if (client?.isReady()) {
            ctx.ui.notify(
              `✅ Connected as ${client.user.tag}\n` +
                `   Channel: #${runtime.sessionChannelName ?? runtime.activeChannelId ?? "(fallback)"}\n` +
                `   Channel ID: ${runtime.activeChannelId ?? "(unknown)"}\n` +
                `   Allow-list: ${activeConfig?.allowedUserIds?.join(", ") || "everyone"}`,
              "info",
            );
          } else if (client) {
            ctx.ui.notify("⏳ Connecting…", "info");
          } else if (reconnectTimer) {
            ctx.ui.notify(
              `🔄 Reconnecting (attempt ${reconnectAttempt}/${RECONNECT_MAX_ATTEMPTS})…`,
              "info",
            );
          } else if (reconnectFailed) {
            ctx.ui.notify(
              `❌ Reconnect failed after ${RECONNECT_MAX_ATTEMPTS} attempts. Run /pi-discord-remote stop then start to retry.`,
              "error",
            );
          } else {
            ctx.ui.notify("❌ Not connected. Run /pi-discord-remote start.", "info");
          }
          break;
        }

        // ── open-config ───────────────────────────────────────────────────
        case "open-config": {
          const raw = existsSync(CONFIG_FILE)
            ? await readFile(CONFIG_FILE, "utf-8")
            : defaultConfigTemplate();

          const edited = await ctx.ui.editor("pi-discord-remote config.json", raw);
          if (!edited) return;

          try {
            const parsed = JSON.parse(edited) as Config;
            await saveConfig(parsed);
            ctx.ui.notify("Config saved.", "success");
          } catch {
            ctx.ui.notify("Invalid JSON — config not saved.", "error");
          }
          break;
        }

        // ── help ──────────────────────────────────────────────────────────
        default: {
          ctx.ui.notify(
            [
              "/pi-discord-remote setup       — configure bot token, guild, category",
              "/pi-discord-remote start       — create channel + connect",
              "/pi-discord-remote stop        — delete channel + disconnect",
              "/pi-discord-remote status      — show connection state",
              "/pi-discord-remote open-config — edit config JSON",
            ].join("\n"),
            "info",
          );
        }
      }
    },
  });
}
