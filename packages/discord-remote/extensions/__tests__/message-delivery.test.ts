import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const discord = vi.hoisted(() => {
  const sent: string[] = [];
  const recordSend = async (text: string) => {
    sent.push(text);
    return { id: `message-${sent.length}` };
  };
  const channel = {
    id: "channel-1",
    name: "test-channel",
    isTextBased: () => true,
    send: vi.fn(recordSend),
    sendTyping: vi.fn(async () => {}),
  };
  return { sent, channel, recordSend, echo: true };
});

vi.mock("discord.js", async () => {
  const { EventEmitter } = await import("node:events");

  class MockClient extends EventEmitter {
    user = { tag: "test-bot" };
    channels = { fetch: vi.fn(async () => discord.channel) };
    guilds = {
      fetch: vi.fn(async () => ({
        channels: { create: vi.fn(async () => discord.channel) },
      })),
    };
    login = vi.fn(async () => {
      this.emit("ready", this);
      return "token";
    });
    isReady = vi.fn(() => true);
    destroy = vi.fn(async () => {});
  }

  return {
    Client: MockClient,
    ChannelType: { GuildText: 0 },
    GatewayIntentBits: {
      Guilds: 1,
      GuildMessages: 2,
      MessageContent: 4,
      DirectMessages: 8,
    },
    Partials: { Channel: 0, Message: 1 },
  };
});

vi.mock("../config.js", () => ({
  loadConfig: vi.fn(),
  loadEffectiveConfig: vi.fn(async () => ({
    token: "test-token",
    guildId: "guild-1",
    echo: discord.echo,
  })),
  loadChannelBindings: vi.fn(async () => ({})),
  saveChannelBinding: vi.fn(),
  saveConfig: vi.fn(),
  CONFIG_FILE: "/unused/config.json",
  defaultConfigTemplate: "{}",
}));

import registerExtension from "../index.js";

type EventHandler = (event: any) => Promise<unknown>;
type CommandHandler = (args: string, ctx: any) => Promise<void>;

function createHarness() {
  const handlers = new Map<string, EventHandler>();
  const busHandlers = new Map<string, (event: any) => unknown>();
  let commandHandler: CommandHandler | undefined;
  const pi = {
    events: {
      on: vi.fn((name: string, handler: (event: any) => unknown) => {
        busHandlers.set(name, handler);
        return () => busHandlers.delete(name);
      }),
      emit: vi.fn((name: string, event: any) => {
        busHandlers.get(name)?.(event);
      }),
    },
    on: vi.fn((name: string, handler: EventHandler) => {
      handlers.set(name, handler);
    }),
    registerCommand: vi.fn((_name: string, spec: { handler: CommandHandler }) => {
      commandHandler = spec.handler;
    }),
    registerTool: vi.fn(),
    sendUserMessage: vi.fn(),
  };

  registerExtension(pi as any);

  return {
    async start() {
      if (!commandHandler) throw new Error("Command was not registered");
      await commandHandler("start", {
        cwd: "/test-project",
        ui: { notify: vi.fn(), setStatus: vi.fn() },
      });
    },
    async emit(name: string, event: any = {}) {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`No handler registered for ${name}`);
      await handler(event);
    },
    async emitBus(name: string, event: any = {}) {
      const handler = busHandlers.get(name);
      if (!handler) throw new Error(`No bus handler registered for ${name}`);
      await handler(event);
    },
    onBus(name: string, handler: (event: any) => unknown) {
      busHandlers.set(name, handler);
    },
  };
}

const BG_REQUEST = "pi-background-tasks:request:v1";
const BG_RESPONSE = "pi-background-tasks:response:v1";
const BG_TERMINAL = "pi-background-tasks:terminal:v1";
const WATCH_REQUEST = "pi-watch:request:v1";
const WATCH_RESPONSE = "pi-watch:response:v1";

function installBackgroundTaskPlugin(
  harness: ReturnType<typeof createHarness>,
  tasks: Array<{ id: string; name?: string; description?: string; status: string }>,
) {
  const requests: any[] = [];
  harness.onBus(BG_REQUEST, (request) => {
    requests.push(request);
    if (request?.operation !== "status") return;
    // The real EventBus service answers asynchronously from its status handler.
    queueMicrotask(() => {
      void harness.emitBus(BG_RESPONSE, {
        schema_version: "pi-background-tasks.extension-response.v1",
        request_id: request.request_id,
        operation: "status",
        ok: true,
        result: { tasks },
      });
    });
  });
  return requests;
}

function terminalBackgroundTask(task: {
  id: string;
  name?: string;
  description?: string;
  status: "completed" | "failed" | "killed";
}) {
  return {
    schema_version: "pi-background-tasks.extension-terminal.v1",
    task,
  };
}

function installWatchPlugin(
  harness: ReturnType<typeof createHarness>,
  watches: Array<{
    id: string;
    name: string;
    mode: "poll" | "stream";
    status: "running" | "paused" | "stopped";
    every_seconds?: number | null;
    broken?: boolean;
    restart_attempt?: number;
  }>,
) {
  const requests: any[] = [];
  harness.onBus(WATCH_REQUEST, (request) => {
    requests.push(request);
    if (request?.operation !== "status") return;
    queueMicrotask(() => {
      void harness.emitBus(WATCH_RESPONSE, {
        schema_version: "pi-watch.extension-response.v1",
        request_id: request.request_id,
        operation: "status",
        ok: true,
        result: { watches },
      });
    });
  });
  return requests;
}

function textMessage(role: "assistant" | "user", text: string) {
  return { message: { role, content: [{ type: "text", text }] } };
}

function customMessage(customType: string, content: unknown, display = true, details?: unknown) {
  return { message: { role: "custom", customType, content, display, details } };
}

const DIVIDER = "────────────────────";

describe("append-only transcript delivery", () => {
  beforeEach(() => {
    discord.sent.length = 0;
    discord.echo = true;
    vi.clearAllMocks();
    discord.channel.send.mockImplementation(discord.recordSend);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("mirrors generic custom-message metadata without exposing content or arbitrary details", async () => {
    const harness = createHarness();
    await harness.start();

    await harness.emit(
      "message_end",
      customMessage(
        "team-message-notification",
        "private team body",
        true,
        { senderName: "Dev Agent 1", messageId: "83c747d3-a941-43df-a7d0-06f87aa5b594" },
      ),
    );
    await harness.emit(
      "message_end",
      customMessage(
        "subagent-notification",
        [{ type: "text", text: "private subagent body" }],
        true,
        { description: "Inspect authentication flow", status: "completed", id: "agent-123456789" },
      ),
    );
    await harness.emit(
      "message_end",
      customMessage(
        "watch-notification",
        "private watch body",
        true,
        { senderName: "delivery-test", messageId: "f1b54347-aa49-45f4-bc5e-ceb88371b5e5" },
      ),
    );
    await harness.emit(
      "message_end",
      customMessage("deployment-notice", "private deployment body", true, {
        name: "deploy-42",
        status: "completed",
      }),
    );
    await harness.emit(
      "message_end",
      customMessage("extension-empty", undefined, true, {
        unexpected: "must not appear",
        nested: { secret: "must not appear either" },
      }),
    );

    expect(discord.sent).toEqual([
      "🔔 **team-message-notification** · Dev Agent 1 · 83c747d3…",
      "🔔 **subagent-notification** · Inspect authentication flow · completed · agent-12…",
      "🔔 **watch-notification** · delivery-test · f1b54347…",
      "🔔 **deployment-notice** · deploy-42 · completed",
      "🔔 **extension-empty**",
    ]);
    expect(discord.sent.join("\n")).not.toContain("private");
    expect(discord.sent.join("\n")).not.toContain("must not appear");
  });

  it("hides non-displayable custom messages and avoids duplicate background completion notices", async () => {
    const harness = createHarness();
    await harness.start();

    await harness.emit("message_end", customMessage("private-extension-state", "hidden", false));
    await harness.emit(
      "message_end",
      customMessage("background-task-notification", "<background-task-notification>raw XML</background-task-notification>"),
    );
    expect(discord.sent).toEqual([]);

    await harness.emitBus(
      BG_TERMINAL,
      terminalBackgroundTask({ id: "build-check", name: "Build check", status: "completed" }),
    );
    expect(discord.sent).toEqual(["✅ Finished: Build check"]);
  });

  it("does not mirror custom messages when echo is disabled", async () => {
    discord.echo = false;
    const harness = createHarness();
    await harness.start();

    await harness.emit("message_end", customMessage("watch-notification", "Watch fired"));
    expect(discord.sent).toEqual([]);
  });

  it("posts A, steering B, and C independently in transcript order", async () => {
    const harness = createHarness();
    await harness.start();
    await harness.emit("agent_start");

    await harness.emit("message_end", textMessage("assistant", "A: before steering"));
    await harness.emit("message_end", textMessage("user", "B: steering message"));
    await harness.emit("message_end", textMessage("assistant", "C: after steering"));

    expect(discord.sent).toEqual([
      "A: before steering",
      `🖥️ **Terminal**: B: steering message\n\n${DIVIDER}`,
      "C: after steering",
    ]);

    await harness.emit("agent_end");
    expect(discord.sent).toEqual([
      "A: before steering",
      `🖥️ **Terminal**: B: steering message\n\n${DIVIDER}`,
      "C: after steering",
      DIVIDER,
    ]);
  });

  it("does not publish partial assistant updates", async () => {
    const harness = createHarness();
    await harness.start();
    await harness.emit("agent_start");

    await harness.emit("message_update", textMessage("assistant", "Partial text"));
    expect(discord.sent).toEqual([]);

    await harness.emit("message_end", textMessage("assistant", "Completed text"));
    expect(discord.sent).toEqual(["Completed text"]);
  });

  it("mirrors Working with refreshed Discord typing until agent_end", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    await harness.start();
    await harness.emit("agent_start");
    expect(discord.channel.sendTyping).not.toHaveBeenCalled();

    await harness.emit("turn_start");
    await harness.emit("turn_start");
    expect(discord.channel.sendTyping).toHaveBeenCalledTimes(1);

    await harness.emit("message_end", textMessage("assistant", "A completed reply"));
    expect(discord.channel.sendTyping).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(8_000);
    expect(discord.channel.sendTyping).toHaveBeenCalledTimes(3);

    await harness.emit("agent_end");
    await vi.advanceTimersByTimeAsync(16_000);
    expect(discord.channel.sendTyping).toHaveBeenCalledTimes(3);
  });

  it("reports aborted agent runs to the persistent session channel", async () => {
    discord.echo = false;
    const harness = createHarness();
    await harness.start();

    await harness.emit("agent_start");
    await harness.emit("agent_end");
    await harness.emit("agent_settled", { aborted: false });
    expect(discord.sent).toEqual([]);

    await harness.emit("agent_start");
    await harness.emit("agent_end");
    await harness.emit("agent_settled", { aborted: true });
    expect(discord.sent).toEqual(["🛑 Agent interrupted"]);
  });

  describe("provider error surfacing", () => {
    const errorMessage = (text = "500: server_error") => ({
      message: { role: "assistant", content: [], stopReason: "error", errorMessage: text },
    });

    it("announces the first error once, then reports recovery", async () => {
      discord.echo = false;
      const harness = createHarness();
      await harness.start();

      await harness.emit("agent_start");
      await harness.emit("message_end", errorMessage());
      await harness.emit("agent_end");
      await harness.emit("agent_start");
      await harness.emit("message_end", errorMessage());
      await harness.emit("agent_end");
      await harness.emit("agent_start");
      await harness.emit("message_end", textMessage("assistant", "Fine now"));
      await harness.emit("agent_end");
      await harness.emit("agent_settled", { aborted: false });

      expect(discord.sent).toEqual([
        "⚠️ Provider error (Pi may retry automatically):\n```\n500: server_error\n```",
        "✅ Recovered after 2 provider errors.",
      ]);
    });

    it("reports a final failure when the run settles on an error", async () => {
      discord.echo = false;
      const harness = createHarness();
      await harness.start();

      await harness.emit("agent_start");
      await harness.emit("message_end", errorMessage("overloaded"));
      await harness.emit("agent_end");
      await harness.emit("agent_settled", { aborted: false });

      expect(discord.sent).toEqual([
        "⚠️ Provider error (Pi may retry automatically):\n```\noverloaded\n```",
        "❌ Run failed after 1 provider error:\n```\noverloaded\n```",
      ]);

      // State is reset: a later clean run posts nothing extra.
      discord.sent.length = 0;
      await harness.emit("agent_start");
      await harness.emit("agent_end");
      await harness.emit("agent_settled", { aborted: false });
      expect(discord.sent).toEqual([]);
    });

    it("does not report failure for an aborted run", async () => {
      discord.echo = false;
      const harness = createHarness();
      await harness.start();

      await harness.emit("agent_start");
      await harness.emit("message_end", errorMessage());
      await harness.emit("agent_end");
      await harness.emit("agent_settled", { aborted: true });

      expect(discord.sent).toHaveLength(2);
      expect(discord.sent[1]).toBe("🛑 Agent interrupted");
    });

    it("neutralises mentions and code fences in error text", async () => {
      discord.echo = false;
      const harness = createHarness();
      await harness.start();

      await harness.emit("agent_start");
      await harness.emit("message_end", errorMessage("@everyone ```boom```"));

      expect(discord.sent[0]).toBe(
        "⚠️ Provider error (Pi may retry automatically):\n```\n@everyone '''boom'''\n```",
      );
    });
  });

  it("posts tool-start summaries but never tool results", async () => {
    const harness = createHarness();
    await harness.start();
    await harness.emit("agent_start");

    await harness.emit("tool_execution_start", {
      toolName: "write",
      args: { path: "/tmp/example.txt" },
    });
    await harness.emit("tool_result", {
      toolName: "write",
      content: [{ type: "text", text: "sensitive tool result" }],
    });

    expect(discord.sent).toEqual(["📝 writing to `/tmp/example.txt`"]);
  });

  it("reports short-lived and idle subagent completions without echo", async () => {
    discord.echo = false;
    const harness = createHarness();
    await harness.start();
    await harness.emitBus("subagents:ready");

    await harness.emitBus("subagents:started", {
      id: "agent-a",
      type: "general-purpose",
      description: "Review authentication flow",
    });
    await harness.emitBus("subagents:completed", { id: "agent-a" });
    await harness.emitBus("subagents:started", { id: "agent-b", type: "Explore" });
    await harness.emitBus("subagents:failed", { id: "agent-b" });

    expect(discord.sent).toEqual([
      "✅ Finished: Review authentication flow",
      "❌ Failed: Explore",
    ]);
  });

  it("marks new and previously reported subagents and background jobs in combined snapshots", async () => {
    const harness = createHarness();
    await harness.start();
    const requests = installBackgroundTaskPlugin(harness, [
      { id: "job-a", name: "Test suite", status: "running" },
      { id: "job-b", name: "Documentation server", status: "running" },
      { id: "job-c", name: "Old completed job", status: "completed" },
    ]);
    await harness.emitBus("subagents:ready");
    await harness.emitBus("subagents:started", {
      id: "agent-a",
      description: "Inspect authentication flow",
    });

    await harness.emit("agent_start");
    await harness.emit("agent_end");
    await harness.emit("agent_start");
    await harness.emit("agent_end");

    expect(discord.sent).toEqual([
      DIVIDER,
      "Running -\n🤖 (New) Inspect authentication flow\n" +
        "⚙️ (New) Test suite\n⚙️ (New) Documentation server",
      DIVIDER,
      "Running -\n🤖 Inspect authentication flow\n" +
        "⚙️ Test suite\n⚙️ Documentation server",
    ]);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      schema_version: "pi-background-tasks.extension-request.v1",
      operation: "status",
      payload: {},
    });
    expect(requests[0].request_id).not.toBe(requests[1].request_id);
  });

  it("shows every watch with new, running, paused, stopped, and broken markers", async () => {
    const harness = createHarness();
    await harness.start();
    const requests = installWatchPlugin(harness, [
      { id: "watch-a", name: "CI failures", mode: "poll", status: "running", every_seconds: 60 },
      { id: "watch-b", name: "GitHub replies", mode: "poll", status: "running", every_seconds: 300 },
      { id: "watch-c", name: "Deployment events", mode: "stream", status: "running" },
      { id: "watch-d", name: "Documentation rebuild", mode: "stream", status: "paused" },
      { id: "watch-e", name: "Previous release monitor", mode: "poll", status: "stopped", every_seconds: 60 },
      { id: "watch-f", name: "Log listener", mode: "stream", status: "running", broken: true, restart_attempt: 2 },
    ]);

    await harness.emit("agent_start");
    await harness.emit("agent_end");
    await harness.emit("agent_start");
    await harness.emit("agent_end");

    expect(discord.sent).toEqual([
      DIVIDER,
      "Running -\n" +
        "👀 (New) CI failures · poll · every 60s\n" +
        "👀 (New) GitHub replies · poll · every 5m\n" +
        "👀 (New) Deployment events · stream\n" +
        "👀 (Paused) Documentation rebuild · stream\n" +
        "👀 (Stopped) Previous release monitor · poll\n" +
        "👀 (Broken, retry #2) Log listener · stream",
      DIVIDER,
      "Running -\n" +
        "👀 CI failures · poll · every 60s\n" +
        "👀 GitHub replies · poll · every 5m\n" +
        "👀 Deployment events · stream\n" +
        "👀 (Paused) Documentation rebuild · stream\n" +
        "👀 (Stopped) Previous release monitor · poll\n" +
        "👀 (Broken, retry #2) Log listener · stream",
    ]);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      schema_version: "pi-watch.extension-request.v1",
      operation: "status",
      payload: {},
    });
    expect(requests[0].request_id).not.toBe(requests[1].request_id);
  });

  it("keeps other activity working when the watch plugin is absent", async () => {
    const harness = createHarness();
    await harness.start();
    await harness.emitBus("subagents:ready");
    await harness.emitBus("subagents:started", {
      id: "agent-a",
      description: "Research API",
    });

    await harness.emit("agent_start");
    await harness.emit("agent_end");

    expect(discord.sent).toEqual([
      DIVIDER,
      "Running -\n🤖 (New) Research API",
    ]);
  });

  it.each([
    { ok: false, error: "watch registry unavailable" },
    { ok: true, result: { watches: "malformed" } },
  ])("isolates watch status failures from other activity: %j", async (response) => {
    const harness = createHarness();
    await harness.start();
    harness.onBus(WATCH_REQUEST, (request) => {
      queueMicrotask(() => {
        void harness.emitBus(WATCH_RESPONSE, {
          schema_version: "pi-watch.extension-response.v1",
          request_id: request.request_id,
          operation: "status",
          ...response,
        });
      });
    });
    await harness.emitBus("subagents:ready");
    await harness.emitBus("subagents:started", {
      id: "agent-a",
      description: "Research API",
    });

    await harness.emit("agent_start");
    await harness.emit("agent_end");

    expect(discord.sent).toEqual([
      DIVIDER,
      "Running -\n🤖 (New) Research API",
    ]);
  });

  it("keeps subagent snapshots working when the background plugin is absent", async () => {
    const harness = createHarness();
    await harness.start();
    await harness.emitBus("subagents:ready");
    await harness.emitBus("subagents:started", {
      id: "agent-a",
      description: "Research API",
    });

    await harness.emit("agent_start");
    await harness.emit("agent_end");

    expect(discord.sent).toEqual([
      DIVIDER,
      "Running -\n🤖 (New) Research API",
    ]);
  });

  it("posts nothing for an empty background-task and subagent snapshot", async () => {
    const harness = createHarness();
    await harness.start();
    installBackgroundTaskPlugin(harness, [
      { id: "job-a", name: "Completed job", status: "completed" },
    ]);

    await harness.emit("agent_start");
    await harness.emit("agent_end");

    expect(discord.sent).toEqual([]);
  });

  it("reports background completions immediately without echo and deduplicates terminal events", async () => {
    discord.echo = false;
    const harness = createHarness();
    await harness.start();

    await harness.emitBus(
      BG_TERMINAL,
      terminalBackgroundTask({ id: "job-a", name: "Ten second sleep", status: "completed" }),
    );
    await harness.emitBus(
      BG_TERMINAL,
      terminalBackgroundTask({ id: "job-a", name: "Ten second sleep", status: "completed" }),
    );
    await harness.emitBus(
      BG_TERMINAL,
      terminalBackgroundTask({ id: "job-b", name: "Test suite", status: "failed" }),
    );
    await harness.emitBus(
      BG_TERMINAL,
      terminalBackgroundTask({ id: "job-c", name: "Dev server", status: "killed" }),
    );

    expect(discord.sent).toEqual([
      "✅ Finished: Ten second sleep",
      "❌ Failed: Test suite",
      "🛑 Stopped: Dev server",
    ]);
  });

  it("serializes immediate subagent and background-task completion messages", async () => {
    const pendingSends: Array<() => void> = [];
    discord.channel.send.mockImplementation(
      (text: string) =>
        new Promise<{ id: string }>((resolve) => {
          pendingSends.push(() => {
            discord.sent.push(text);
            resolve({ id: `message-${discord.sent.length}` });
          });
        }),
    );
    const harness = createHarness();
    await harness.start();
    await harness.emitBus("subagents:ready");
    await harness.emitBus("subagents:started", { id: "agent-a", description: "First task" });
    await harness.emitBus("subagents:started", { id: "agent-b", description: "Second task" });

    const first = harness.emitBus("subagents:completed", { id: "agent-a" });
    const second = harness.emitBus("subagents:completed", { id: "agent-b" });
    const third = harness.emitBus(
      BG_TERMINAL,
      terminalBackgroundTask({ id: "job-a", name: "Third task", status: "completed" }),
    );
    for (const expected of ["First task", "Second task", "Third task"]) {
      await vi.waitFor(() => expect(pendingSends).toHaveLength(1));
      pendingSends.shift()!();
      await vi.waitFor(() => expect(discord.sent.some((text) => text.endsWith(expected))).toBe(true));
    }
    await Promise.all([first, second, third]);

    expect(discord.sent).toEqual([
      "✅ Finished: First task",
      "✅ Finished: Second task",
      "✅ Finished: Third task",
    ]);
  });

  it("skips empty assistant messages and their completion footer", async () => {
    const harness = createHarness();
    await harness.start();
    await harness.emit("agent_start");

    await harness.emit("message_end", textMessage("assistant", "  \n"));
    await harness.emit("agent_end");

    expect(discord.sent).toEqual([]);
  });
});
