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
import { loadEffectiveConfig } from "../config.js";

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
    expect(second.pi.sendUserMessage).toHaveBeenCalledWith("[<@user-1>]: after reload");
    expect(first.pi.sendUserMessage).not.toHaveBeenCalled();

    await second.emit("session_shutdown", { reason: "quit" });
    expect(client.destroy).toHaveBeenCalledOnce();
  });

  it("forces a reconnect when the bridged client is not ready after reload", async () => {
    vi.useFakeTimers();
    try {
      const first = createHarness();
      await first.start({ cwd: "/test-project", ui: makeUi() });
      const before = discord.instances.length;
      const client = discord.instances[before - 1];
      client.isReady.mockReturnValue(false);

      await first.emit("session_shutdown", { reason: "reload" });

      const second = createHarness();
      await second.emit("session_start", { reason: "reload" }, { cwd: "/test-project", ui: makeUi() });
      expect(discord.instances).toHaveLength(before);

      // Grace period elapses; the unhealthy bridged client must be replaced.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(discord.instances).toHaveLength(before);
      await vi.advanceTimersByTimeAsync(3_100); // first reconnect delay (2s + jitter < 1s)
      expect(client.destroy).toHaveBeenCalled();
      expect(discord.instances).toHaveLength(before + 1);
      expect(discord.instances[before].login).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("includes Discord mention tokens unless the user is configured with null", async () => {
    vi.mocked(loadEffectiveConfig).mockResolvedValueOnce({
      token: "test-token",
      guildId: "guild-1",
      displayNames: {
        "assigned-user": "Assigned Name",
        "default-user": null,
      },
    });
    const harness = createHarness();
    await harness.start({ cwd: "/test-project", ui: makeUi() });
    const client = discord.instances[discord.instances.length - 1];
    const messageHandler = client.listeners("messageCreate")[0];

    const send = async (
      id: string,
      username: string,
      content: string,
      names: { member?: string; global?: string } = {},
    ) => {
      await messageHandler({
        author: { bot: false, id, username, displayName: names.global },
        member: names.member === undefined ? null : { displayName: names.member },
        channelId: "channel-1",
        content,
        react: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
      });
    };

    await send("assigned-user", "assigned_handle", "assigned", {
      member: "Server Nickname",
      global: "Global Name",
    });
    await send("nickname-user", "server_handle", "nickname", { member: "Server Nickname" });
    await send("global-user", "global_handle", "global", { global: "Global Name" });
    await send("username-user", "handle_only", "username");
    await send("default-user", "default_handle", "no attribution", {
      member: "Server Nickname",
      global: "Global Name",
    });

    expect(harness.pi.sendUserMessage.mock.calls.map(([text]) => text)).toEqual([
      "[Assigned Name (<@assigned-user>)]: assigned",
      "[Server Nickname (<@nickname-user>)]: nickname",
      "[Global Name (<@global-user>)]: global",
      "[<@username-user>]: username",
      "no attribution",
    ]);

    await harness.emit("session_shutdown", { reason: "quit" });
  });
});
