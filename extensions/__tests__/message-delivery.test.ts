import { beforeEach, describe, expect, it, vi } from "vitest";

const discord = vi.hoisted(() => {
  const sent: string[] = [];
  const channel = {
    id: "channel-1",
    name: "test-channel",
    isTextBased: () => true,
    send: vi.fn(async (text: string) => {
      sent.push(text);
      return { id: `message-${sent.length}` };
    }),
  };
  return { sent, channel };
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
    echo: true,
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
  let commandHandler: CommandHandler | undefined;
  const pi = {
    events: { on: vi.fn(() => () => {}) },
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
  };
}

function textMessage(role: "assistant" | "user", text: string) {
  return { message: { role, content: [{ type: "text", text }] } };
}

const DIVIDER = "────────────────────";

describe("append-only transcript delivery", () => {
  beforeEach(() => {
    discord.sent.length = 0;
    vi.clearAllMocks();
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

  it("skips empty assistant messages and their completion footer", async () => {
    const harness = createHarness();
    await harness.start();
    await harness.emit("agent_start");

    await harness.emit("message_end", textMessage("assistant", "  \n"));
    await harness.emit("agent_end");

    expect(discord.sent).toEqual([]);
  });
});
