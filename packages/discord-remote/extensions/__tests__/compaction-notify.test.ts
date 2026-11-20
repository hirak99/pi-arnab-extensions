import { beforeEach, describe, expect, it, vi } from "vitest";

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
      return handler(event);
    },
  };
}

describe("compaction lifecycle notifications", () => {
  beforeEach(() => {
    discord.sent.length = 0;
    discord.echo = true;
    vi.clearAllMocks();
    discord.channel.send.mockImplementation(discord.recordSend);
  });

  it("registers all three compaction handlers", () => {
    const harness = createHarness();
    expect(harness.emit("session_before_compact", {})).resolves.toBeUndefined();
    expect(harness.emit("session_compact", {})).resolves.toBeUndefined();
    expect(harness.emit("session_compact_failed", {})).resolves.toBeUndefined();
  });

  it("posts a start message with the threshold reason", async () => {
    const harness = createHarness();
    await harness.start();

    await harness.emit("session_before_compact", { reason: "threshold" });
    expect(discord.sent).toEqual(["🗜️ Compacting context… (context threshold reached)"]);
  });

  it("posts a start message with the overflow and manual reasons", async () => {
    const harness = createHarness();
    await harness.start();

    await harness.emit("session_before_compact", { reason: "overflow" });
    await harness.emit("session_before_compact", { reason: "manual" });

    expect(discord.sent).toEqual([
      "🗜️ Compacting context… (context overflow recovery)",
      "🗜️ Compacting context… (manual /compact)",
    ]);
  });

  it("does not send anything when Discord is not connected", async () => {
    const harness = createHarness();
    // Never call start() — no client, no channel.
    await harness.emit("session_before_compact", { reason: "threshold" });
    await harness.emit("session_compact", { compactionEntry: { tokensBefore: 1000 } });
    await harness.emit("session_compact_failed", { errorMessage: "boom" });
    expect(discord.sent).toEqual([]);
  });

  it("session_before_compact returns undefined so compaction is never cancelled", async () => {
    const harness = createHarness();
    await harness.start();
    const result = await harness.emit("session_before_compact", { reason: "threshold" });
    expect(result).toBeUndefined();
  });

  it("posts a done message with formatted tokensBefore", async () => {
    const harness = createHarness();
    await harness.start();

    await harness.emit("session_compact", {
      reason: "threshold",
      compactionEntry: { tokensBefore: 123456 },
    });
    expect(discord.sent).toEqual(["✅ Compaction done — 123,456 tokens before."]);
  });

  it("posts a done message without tokens when unknown", async () => {
    const harness = createHarness();
    await harness.start();

    await harness.emit("session_compact", { reason: "manual" });
    expect(discord.sent).toEqual(["✅ Compaction done."]);
  });

  it("posts a cancelled message for aborted failures", async () => {
    const harness = createHarness();
    await harness.start();

    await harness.emit("session_compact_failed", { reason: "threshold", aborted: true });
    expect(discord.sent).toEqual(["🛑 Compaction cancelled."]);
  });

  it("posts an error message for non-abort failures", async () => {
    const harness = createHarness();
    await harness.start();

    await harness.emit("session_compact_failed", {
      reason: "overflow",
      aborted: false,
      errorMessage: "Context overflow recovery failed: model error",
    });
    expect(discord.sent).toEqual(["❌ Compaction failed: Context overflow recovery failed: model error"]);
  });

  it("falls back to 'unknown error' when errorMessage is missing", async () => {
    const harness = createHarness();
    await harness.start();

    await harness.emit("session_compact_failed", { reason: "threshold" });
    expect(discord.sent).toEqual(["❌ Compaction failed: unknown error"]);
  });

  it("does not send a separate cancellation message on a clean start→done cycle", async () => {
    const harness = createHarness();
    await harness.start();

    await harness.emit("session_before_compact", { reason: "threshold" });
    await harness.emit("session_compact", {
      reason: "threshold",
      compactionEntry: { tokensBefore: 50000 },
    });

    expect(discord.sent).toEqual([
      "🗜️ Compacting context… (context threshold reached)",
      "✅ Compaction done — 50,000 tokens before.",
    ]);
  });
});
