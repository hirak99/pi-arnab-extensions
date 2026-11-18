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

function textMessage(role: "assistant" | "user", text: string) {
  return { message: { role, content: [{ type: "text", text }] } };
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

  it("posts A, steering B, and C independently in transcript order", async () => {
    const harness = createHarness();
    await harness.start();
    await harness.emit("agent_start");

    await harness.emit("message_end", textMessage("assistant", "A: before steering"));
    await harness.emit("message_end", textMessage("user", "B: steering message"));
    await harness.emit("message_end", textMessage("assistant", "C: after steering"));

    expect(discord.sent).toEqual([
      "A: before steering",
      `🖥️ **You** (terminal): B: steering message\n\n${DIVIDER}`,
      "C: after steering",
    ]);

    await harness.emit("agent_end");
    expect(discord.sent).toEqual([
      "A: before steering",
      `🖥️ **You** (terminal): B: steering message\n\n${DIVIDER}`,
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
      "🤖 1 subagent working…\n🆕 Inspect authentication flow\n\n" +
        "⚙️ 2 background jobs running…\n🆕 Test suite\n🆕 Documentation server",
      DIVIDER,
      "🤖 1 subagent working…\n⏳ Inspect authentication flow\n\n" +
        "⚙️ 2 background jobs running…\n⏳ Test suite\n⏳ Documentation server",
    ]);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      schema_version: "pi-background-tasks.extension-request.v1",
      operation: "status",
      payload: {},
    });
    expect(requests[0].request_id).not.toBe(requests[1].request_id);
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
      "🤖 1 subagent working…\n🆕 Research API",
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
