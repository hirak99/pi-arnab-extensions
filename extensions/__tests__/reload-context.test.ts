import { afterEach, describe, expect, it, vi } from "vitest";

const discord = vi.hoisted(() => {
  const channel = {
    id: "channel-1",
    name: "test-channel",
    isTextBased: () => true,
    send: vi.fn(async () => ({})),
    sendTyping: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  };
  return { channel, instances: [] as any[] };
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

    constructor() {
      super();
      discord.instances.push(this);
    }
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
    echo: false,
  })),
  loadChannelBindings: vi.fn(async () => ({})),
  saveChannelBinding: vi.fn(),
  saveConfig: vi.fn(),
  CONFIG_FILE: "/unused/config.json",
  defaultConfigTemplate: "{}",
}));

import registerExtension from "../index.js";

type EventHandler = (event: any, ctx?: any) => Promise<unknown>;

function createHarness() {
  const handlers = new Map<string, EventHandler>();
  const busHandlers = new Map<string, (event: any) => unknown>();
  let commandHandler: ((args: string, ctx: any) => Promise<void>) | undefined;
  const pi = {
    events: {
      on: vi.fn((name: string, handler: (event: any) => unknown) => {
        busHandlers.set(name, handler);
        return () => busHandlers.delete(name);
      }),
      emit: vi.fn(),
    },
    on: vi.fn((name: string, handler: EventHandler) => {
      handlers.set(name, handler);
    }),
    registerCommand: vi.fn((_name: string, spec: { handler: typeof commandHandler }) => {
      commandHandler = spec.handler;
    }),
    registerTool: vi.fn(),
    sendUserMessage: vi.fn(),
  };

  registerExtension(pi as any);

  return {
    pi,
    async start(ctx: any) {
      if (!commandHandler) throw new Error("Command was not registered");
      await commandHandler("start", ctx);
    },
    async emit(name: string, event: any = {}, ctx?: any) {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`No handler registered for ${name}`);
      await handler(event, ctx);
    },
  };
}

function makeUi() {
  return { notify: vi.fn(), setStatus: vi.fn() };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Discord client reload handoff", () => {
  it("adopts the live client without retaining stale pi or ctx callbacks", async () => {
    const first = createHarness();
    const oldUi = makeUi();
    await first.start({ cwd: "/test-project", ui: oldUi });
    const client = discord.instances[0];
    expect(client.listenerCount("messageCreate")).toBe(1);
    expect(client.listenerCount("error")).toBe(1);

    await first.emit("session_shutdown", { reason: "reload" });
    expect(client.listenerCount("messageCreate")).toBe(0);
    expect(client.listenerCount("error")).toBe(0);
    expect(client.listenerCount("shardDisconnect")).toBe(0);
    expect(client.destroy).not.toHaveBeenCalled();
    oldUi.notify.mockClear();
    oldUi.setStatus.mockClear();
    oldUi.notify.mockImplementation(() => {
      throw new Error("stale ctx");
    });
    oldUi.setStatus.mockImplementation(() => {
      throw new Error("stale ctx");
    });

    const second = createHarness();
    const newUi = makeUi();
    await second.emit("session_start", { reason: "reload" }, { cwd: "/test-project", ui: newUi });

    expect(discord.instances).toHaveLength(1);
    expect(client.listenerCount("messageCreate")).toBe(1);
    expect(client.listenerCount("error")).toBe(1);
    expect(client.listenerCount("shardDisconnect")).toBe(1);
    expect(newUi.setStatus).toHaveBeenCalledWith(
      "pi-discord-remote",
      expect.stringMatching(/^🔌 Discord: #test-project-/),
    );

    expect(() => client.emit("error", new Error("network failure"))).not.toThrow();
    expect(newUi.setStatus).toHaveBeenCalledWith("pi-discord-remote", "⚠️ Discord: error");
    expect(oldUi.setStatus).not.toHaveBeenCalled();

    const incoming = {
      author: { bot: false, id: "user-1", username: "tester" },
      member: null,
      channelId: "channel-1",
      content: "after reload",
      react: vi.fn(async () => {}),
      reply: vi.fn(async () => {}),
    };
    const messageHandler = client.listeners("messageCreate")[0];
    await messageHandler(incoming);
    expect(second.pi.sendUserMessage).toHaveBeenCalledWith("[tester]: after reload");
    expect(first.pi.sendUserMessage).not.toHaveBeenCalled();

    await second.emit("session_shutdown", { reason: "quit" });
    expect(client.destroy).toHaveBeenCalledOnce();
  });
});
