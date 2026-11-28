import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const discord = vi.hoisted(() => {
  const channel = {
    id: "channel-1",
    name: "test-channel",
    isTextBased: () => true,
    send: vi.fn(async (_text: string) => ({})),
    sendTyping: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  };
  return { channel, instances: [] as any[], sent: [] as string[], loginGate: null as Promise<void> | null };
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
      if (discord.loginGate) await discord.loginGate;
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

function createHarness(extension: typeof registerExtension = registerExtension) {
  const handlers = new Map<string, EventHandler>();
  const tools = new Map<string, any>();
  let commandHandler: ((args: string, ctx: any) => Promise<void>) | undefined;
  let commandName: string | undefined;
  const pi = {
    events: sharedEventBus,
    on: vi.fn((name: string, handler: EventHandler) => {
      handlers.set(name, handler);
    }),
    registerCommand: vi.fn((name: string, spec: { handler: typeof commandHandler }) => {
      commandName = name;
      commandHandler = spec.handler;
    }),
    registerTool: vi.fn((spec: any) => {
      tools.set(spec.name, spec);
    }),
    sendUserMessage: vi.fn(),
  };

  extension(pi as any);

  return {
    pi,
    commandName: () => commandName,
    hasHandler: (name: string) => handlers.has(name),
    tool: (name: string) => {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool was not registered: ${name}`);
      return tool;
    },
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

function makeAutoStartContext(options: { parentSession?: string; persisted?: boolean; interactive?: boolean } = {}) {
  const persisted = options.persisted ?? true;
  return {
    cwd: "/test-project",
    ui: makeUi(),
    hasUI: options.interactive ?? true,
    sessionManager: {
      getSessionId: () => "session-1",
      getSessionFile: () => persisted ? "/test-project/session.jsonl" : undefined,
      getHeader: () => ({ parentSession: options.parentSession }),
    },
  };
}

let sharedEventBus: ReturnType<typeof createEventBus>;

beforeEach(() => {
  sharedEventBus = createEventBus();
  discord.sent.length = 0;
  discord.instances.length = 0;
  discord.loginGate = null;
});

afterEach(() => {
  sharedEventBus.clear();
  Reflect.deleteProperty(globalThis, Symbol.for("pi-discord-remote.reload-bridge"));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Discord client reload handoff", () => {
  it("registers only the concise discord command", () => {
    const harness = createHarness();
    expect(harness.commandName()).toBe("discord");
    expect(harness.pi.registerCommand).toHaveBeenCalledOnce();
    expect(harness.pi.registerCommand).not.toHaveBeenCalledWith("pi-discord-remote", expect.anything());
  });

  it("registers only the image tool without intercepting question tools", () => {
    const harness = createHarness();
    expect(harness.pi.registerTool.mock.calls.map(([spec]) => spec.name)).toEqual(["discord_send_image"]);
    expect(harness.hasHandler("tool_call")).toBe(false);
  });

  it.each(["new", "resume", "startup"])("auto-starts a %s session when the project opts in", async (reason) => {
    vi.mocked(loadEffectiveConfig).mockResolvedValueOnce({
      token: "test-token",
      guildId: "guild-1",
      autoStart: true,
    });
    const harness = createHarness();
    const before = discord.instances.length;

    await harness.emit("session_start", { reason }, makeAutoStartContext());

    expect(discord.instances).toHaveLength(before + 1);
    expect(discord.instances[before].login).toHaveBeenCalledWith("test-token");
    expect(loadEffectiveConfig).toHaveBeenCalledWith("/test-project");
    await harness.emit("session_shutdown", { reason: "quit" });
  });

  it("auto-starts a parent-linked top-level startup session", async () => {
    vi.mocked(loadEffectiveConfig).mockResolvedValueOnce({
      token: "test-token",
      guildId: "guild-1",
      autoStart: true,
    });
    const harness = createHarness();
    const before = discord.instances.length;

    await harness.emit(
      "session_start",
      { reason: "startup" },
      makeAutoStartContext({ parentSession: "/test-project/previous-root.jsonl" }),
    );

    expect(discord.instances).toHaveLength(before + 1);
    await harness.emit("session_shutdown", { reason: "quit" });
  });

  it.each(["new", "resume", "startup"])("does not auto-start a persisted nested %s session", async (reason) => {
    vi.mocked(loadEffectiveConfig).mockClear();
    const harness = createHarness();
    const before = discord.instances.length;

    await harness.emit(
      "session_start",
      { reason },
      makeAutoStartContext({ parentSession: "/test-project/parent.jsonl", interactive: false }),
    );

    expect(discord.instances).toHaveLength(before);
    expect(loadEffectiveConfig).not.toHaveBeenCalled();
  });

  it.each(["new", "resume", "startup"])("does not auto-start an in-memory %s session", async (reason) => {
    vi.mocked(loadEffectiveConfig).mockClear();
    const harness = createHarness();
    const before = discord.instances.length;

    await harness.emit(
      "session_start",
      { reason },
      makeAutoStartContext({ persisted: false, interactive: false }),
    );

    expect(discord.instances).toHaveLength(before);
    expect(loadEffectiveConfig).not.toHaveBeenCalled();
  });

  it("adopts the live client without retaining stale pi or ctx callbacks", async () => {
    const first = createHarness();
    const oldUi = makeUi();
    await first.start({ ...makeAutoStartContext(), ui: oldUi });
    const client = discord.instances[discord.instances.length - 1];
    expect(client.listenerCount("messageCreate")).toBe(1);
    expect(client.listenerCount("error")).toBe(1);

    await first.emit("session_shutdown", { reason: "reload" });
    expect(client.listenerCount("messageCreate")).toBe(1);
    const storedBridge = Reflect.get(globalThis, Symbol.for("pi-discord-remote.reload-bridge"));
    expect(storedBridge).toMatchObject({ sessionId: "session-1", root: "/test-project" });
    expect(client.listenerCount("error")).toBe(1);
    expect(client.listenerCount("shardDisconnect")).toBe(1);
    expect(client.destroy).not.toHaveBeenCalled();
    oldUi.notify.mockClear();
    oldUi.setStatus.mockClear();
    oldUi.notify.mockImplementation(() => {
      throw new Error("stale ctx");
    });
    oldUi.setStatus.mockImplementation(() => {
      throw new Error("stale ctx");
    });

    const instanceCount = discord.instances.length;
    const freshSpecifier = "../index.js?fresh-module-adoption";
    const freshExtension = (await import(freshSpecifier)).default;
    const second = createHarness(freshExtension);
    const newUi = makeUi();
    await second.emit("session_start", { reason: "reload" }, { ...makeAutoStartContext(), ui: newUi });

    expect(discord.instances).toHaveLength(instanceCount);
    expect(client.listenerCount("messageCreate")).toBe(1);
    expect(client.listenerCount("error")).toBe(1);
    expect(client.listenerCount("shardDisconnect")).toBe(1);
    expect(newUi.setStatus).toHaveBeenCalledWith(
      "pi-discord-remote",
      expect.stringMatching(/💬 Discord: #test-project-/),
    );

    expect(() => client.emit("error", new Error("network failure"))).not.toThrow();
    await vi.waitFor(() => {
      expect(newUi.setStatus).toHaveBeenCalledWith(
        "pi-discord-remote",
        expect.stringContaining("⚠️ Discord: error"),
      );
    });
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
    await vi.waitFor(() => expect(second.pi.sendUserMessage).toHaveBeenCalledWith("[<@user-1>]: after reload"));
    expect(first.pi.sendUserMessage).not.toHaveBeenCalled();

    await second.emit("session_shutdown", { reason: "quit" });
    expect(client.destroy).toHaveBeenCalledOnce();
  });

  it("buffers gateway and shared activity events during the fresh-module handoff", async () => {
    const first = createHarness();
    const oldUi = makeUi();
    await first.start({ ...makeAutoStartContext(), ui: oldUi });
    const client = discord.instances[discord.instances.length - 1];
    const sentinel = vi.fn();
    const removeSentinel = sharedEventBus.on("subagents:started", sentinel);
    discord.channel.send.mockClear();
    await first.emit("session_shutdown", { reason: "reload" });
    oldUi.notify.mockClear();
    oldUi.setStatus.mockClear();
    oldUi.notify.mockImplementation(() => { throw new Error("stale UI"); });
    oldUi.setStatus.mockImplementation(() => { throw new Error("stale UI"); });

    const incoming = (content: string) => ({
      author: { bot: false, id: "user-1", username: "tester" },
      member: null,
      channelId: "channel-1",
      content,
      react: vi.fn(async () => {}),
      reply: vi.fn(async () => {}),
    });
    client.emit("messageCreate", incoming("gap one"));
    expect(() => client.emit("error", new Error("gap error"))).not.toThrow();
    client.emit("messageCreate", incoming("gap two"));
    sharedEventBus.emit("subagents:started", { id: "gap-agent", description: "Gap activity" });
    sharedEventBus.emit("subagents:completed", { id: "gap-agent" });
    expect(first.pi.sendUserMessage).not.toHaveBeenCalled();
    expect(sentinel).toHaveBeenCalledOnce();

    const reloadSpecifier = "../index.js?buffered-gateway-and-activity";
    const freshExtension = (await import(reloadSpecifier)).default;
    const second = createHarness(freshExtension);
    const newUi = makeUi();
    await second.emit("session_start", { reason: "reload" }, { ...makeAutoStartContext(), ui: newUi });
    await vi.waitFor(() => expect(second.pi.sendUserMessage.mock.calls.map(([text]) => text)).toEqual([
      "[<@user-1>]: gap one",
      "[<@user-1>]: gap two",
    ]));
    await vi.waitFor(() => expect(discord.channel.send).toHaveBeenCalledWith("✅ Finished: Gap activity"));
    await vi.waitFor(() => expect(newUi.setStatus).toHaveBeenCalledWith(
      "pi-discord-remote",
      expect.stringContaining("⚠️ Discord: error"),
    ));
    expect(oldUi.setStatus).not.toHaveBeenCalled();
    expect(client.listenerCount("messageCreate")).toBe(1);
    expect(client.listenerCount("error")).toBe(1);
    expect(sentinel).toHaveBeenCalledOnce();
    await second.emit("session_shutdown", { reason: "quit" });
    removeSentinel();
  });

  it("preserves an accepted prompt route and echo suppression across pre-agent reload", async () => {
    vi.mocked(loadEffectiveConfig).mockResolvedValueOnce({
      token: "test-token",
      guildId: "guild-1",
      echo: true,
    });
    const first = createHarness();
    await first.start(makeAutoStartContext());
    const client = discord.instances[discord.instances.length - 1];
    discord.channel.send.mockClear();
    client.emit("messageCreate", {
      author: { bot: false, id: "user-1", username: "tester" },
      member: null,
      channelId: "channel-1",
      content: "pending prompt",
      react: vi.fn(async () => {}),
      reply: vi.fn(async () => {}),
    });
    await vi.waitFor(() => expect(first.pi.sendUserMessage).toHaveBeenCalledWith("[<@user-1>]: pending prompt"));
    await first.emit("session_shutdown", { reason: "reload" });

    const reloadSpecifier = "../index.js?pending-prompt-adoption";
    const freshExtension = (await import(reloadSpecifier)).default;
    const second = createHarness(freshExtension);
    await second.emit("session_start", { reason: "reload" }, makeAutoStartContext());
    await second.emit("message_end", {
      message: { role: "user", content: [{ type: "text", text: "[<@user-1>]: pending prompt" }] },
    });
    await second.emit("message_end", {
      message: { role: "assistant", content: [{ type: "text", text: "answer" }] },
    });
    await second.emit("agent_end");
    await vi.waitFor(() => expect(discord.channel.send.mock.calls.map(([text]) => text)).toEqual([
      "answer",
      "<@user-1> ────────────────────",
    ]));
    expect(discord.channel.send).toHaveBeenCalledTimes(2);
    await second.emit("session_shutdown", { reason: "quit" });
  });

  it("cancels pre-login configuration continuation when reload has no client to bridge", async () => {
    let resolveConfig!: (cfg: any) => void;
    vi.mocked(loadEffectiveConfig).mockReturnValueOnce(new Promise((resolve) => { resolveConfig = resolve; }));
    const first = createHarness();
    const starting = first.start(makeAutoStartContext());
    await vi.waitFor(() => expect(loadEffectiveConfig).toHaveBeenCalled());
    await first.emit("session_shutdown", { reason: "reload" });
    resolveConfig({ token: "test-token", guildId: "guild-1", echo: false });
    await starting;
    expect(discord.instances).toHaveLength(0);
  });

  it("finishes in-flight login and channel initialization before reload handoff", async () => {
    let releaseReady!: () => void;
    discord.loginGate = new Promise<void>((resolve) => { releaseReady = resolve; });
    const first = createHarness();
    const starting = first.start(makeAutoStartContext());
    await vi.waitFor(() => expect(discord.instances).toHaveLength(1));
    const initialClient = discord.instances[0];

    let shutdownSettled = false;
    const shutdown = first.emit("session_shutdown", { reason: "reload" }).finally(() => {
      shutdownSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(shutdownSettled).toBe(false);
    expect(initialClient.destroy).not.toHaveBeenCalled();

    releaseReady();
    await starting;
    await shutdown;
    discord.loginGate = null;
    const reloadSpecifier = "../index.js?reload-inflight-initialization";
    const freshExtension = (await import(reloadSpecifier)).default;
    const second = createHarness(freshExtension);
    const ctx = makeAutoStartContext();
    await second.emit("session_start", { reason: "reload" }, ctx);
    expect(discord.instances).toHaveLength(1);
    expect(initialClient.destroy).not.toHaveBeenCalled();
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("pi-discord-remote", expect.stringContaining("#test-project"));
    await second.emit("session_shutdown", { reason: "quit" });
  });

  it("resumes reconnect attempts at their remaining backoff across reload", async () => {
    vi.useFakeTimers();
    const first = createHarness();
    const firstCtx = makeAutoStartContext();
    await first.start(firstCtx);
    const initialClient = discord.instances[0];
    initialClient.isReady.mockReturnValue(false);
    initialClient.emit("shardDisconnect", {});
    await vi.waitFor(() => {
      expect(first.pi.events).toBe(sharedEventBus);
      expect(discord.instances).toHaveLength(1);
    });
    await vi.waitFor(() => expect(firstCtx.ui.setStatus).toHaveBeenCalledWith(
      "pi-discord-remote",
      expect.stringContaining("reconnecting (1/10)"),
    ));
    await vi.advanceTimersByTimeAsync(1500);
    expect(discord.instances).toHaveLength(1);

    await first.emit("session_shutdown", { reason: "reload" });
    const reloadSpecifier = "../index.js?reload-reconnect-backoff";
    const freshExtension = (await import(reloadSpecifier)).default;
    const second = createHarness(freshExtension);
    const secondCtx = makeAutoStartContext();
    await second.emit("session_start", { reason: "reload" }, secondCtx);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.waitFor(() => expect(discord.instances).toHaveLength(2));
    const replacement = discord.instances[1];
    expect(replacement.login).toHaveBeenCalledOnce();
    expect(replacement.isReady()).toBe(true);
    await vi.waitFor(() => expect(secondCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Discord reconnected"),
      "success",
    ));
    await second.emit("session_shutdown", { reason: "quit" });
    vi.useRealTimers();
  });

  it("preserves reported activity and terminal dedupe across reload", async () => {
    const backgroundTasks = [{ id: "job-a", name: "Running job", status: "running" }];
    const runningWatches = [{ id: "watch-a", name: "Running watch", mode: "poll", status: "running" }];
    sharedEventBus.on("pi-background-tasks:request:v1", (request: any) => {
      sharedEventBus.emit("pi-background-tasks:response:v1", {
        schema_version: "pi-background-tasks.extension-response.v1",
        request_id: request.request_id,
        operation: "status",
        ok: true,
        result: { tasks: backgroundTasks },
      });
    });
    sharedEventBus.on("pi-watch:request:v1", (request: any) => {
      sharedEventBus.emit("pi-watch:response:v1", {
        schema_version: "pi-watch.extension-response.v1",
        request_id: request.request_id,
        operation: "status",
        ok: true,
        result: { watches: runningWatches },
      });
    });
    const first = createHarness();
    vi.mocked(loadEffectiveConfig).mockResolvedValueOnce({ token: "test-token", guildId: "guild-1", echo: true });
    await first.start(makeAutoStartContext());
    sharedEventBus.emit("subagents:ready", {});
    sharedEventBus.emit("subagents:started", { id: "agent-a", description: "Persistent agent" });
    await vi.waitFor(() => expect(first.pi.events).toBe(sharedEventBus));
    await first.emit("agent_start");
    await first.emit("agent_end");
    await vi.waitFor(() => {
      const texts = discord.channel.send.mock.calls.map(([text]) => text);
      expect(texts.some((text) => text.includes("🤖 (New) Persistent agent") && text.includes("🧵 (New) Running job") && text.includes("👀 (New) Running watch")), JSON.stringify(texts)).toBe(true);
    });
    await first.emit("message_end", {
      message: {
        role: "custom",
        customType: "background-task-notification",
        display: true,
        details: { id: "settled-job", name: "Settled job", status: "completed" },
      },
    });
    await first.emit("session_shutdown", { reason: "reload" });

    const reloadSpecifier = "../index.js?activity-state-adoption";
    const freshExtension = (await import(reloadSpecifier)).default;
    const second = createHarness(freshExtension);
    await second.emit("session_start", { reason: "reload" }, makeAutoStartContext());
    await second.emit("agent_start");
    await second.emit("agent_end");
    await vi.waitFor(() => {
      const snapshots = discord.channel.send.mock.calls.map(([text]) => text).filter((text) => text.startsWith("Running -"));
      expect(snapshots.length).toBe(2);
      expect(snapshots[1]).toContain("🤖 Persistent agent");
      expect(snapshots[1]).toContain("🧵 Running job");
      expect(snapshots[1]).toContain("👀 Running watch");
      expect(snapshots[1]).not.toContain("(New)");
    });
    sharedEventBus.emit("subagents:completed", { id: "agent-a" });
    await vi.waitFor(() => expect(discord.channel.send).toHaveBeenCalledWith("✅ Finished: Persistent agent"));
    sharedEventBus.emit("pi-background-tasks:terminal:v1", {
      schema_version: "pi-background-tasks.extension-terminal.v1",
      task: { id: "settled-job", name: "Settled job", status: "completed" },
    });
    sharedEventBus.emit("pi-background-tasks:terminal:v1", {
      schema_version: "pi-background-tasks.extension-terminal.v1",
      task: { id: "dedupe-sentinel", name: "Dedupe sentinel", status: "completed" },
    });
    await vi.waitFor(() => expect(discord.channel.send).toHaveBeenCalledWith("✅ Finished: Dedupe sentinel"));
    expect(discord.channel.send.mock.calls.filter(([text]) => text === "✅ Finished: Settled job")).toHaveLength(1);
    await second.emit("session_shutdown", { reason: "quit" });
  });

  it("keeps activity reports ordered through a blocked reload handoff", async () => {
    const pendingSends: Array<() => void> = [];
    discord.channel.send.mockImplementation((text: string) => new Promise<{ id: string }>((resolve) => {
      pendingSends.push(() => {
        discord.sent.push(text);
        resolve({ id: `message-${discord.sent.length}` });
      });
    }));
    discord.sent.length = 0;
    const first = createHarness();
    await first.start(makeAutoStartContext());
    sharedEventBus.emit("subagents:ready", {});
    sharedEventBus.emit("subagents:started", { id: "agent-a", description: "A" });
    sharedEventBus.emit("subagents:completed", { id: "agent-a" });
    await vi.waitFor(() => expect(pendingSends).toHaveLength(1));
    const secondReport = first.emit("message_end", {
      message: {
        role: "custom",
        customType: "background-task-notification",
        display: true,
        details: { id: "job-b", name: "B", status: "completed" },
      },
    });
    await first.emit("session_shutdown", { reason: "reload" });
    sharedEventBus.emit("pi-background-tasks:terminal:v1", {
      schema_version: "pi-background-tasks.extension-terminal.v1",
      task: { id: "job-c", name: "C", status: "completed" },
    });

    const reloadSpecifier = "../index.js?ordered-activity-adoption";
    const freshExtension = (await import(reloadSpecifier)).default;
    const second = createHarness(freshExtension);
    await second.emit("session_start", { reason: "reload" }, makeAutoStartContext());
    for (const expected of ["A", "B", "C"]) {
      await vi.waitFor(() => expect(pendingSends).toHaveLength(1));
      pendingSends.shift()!();
      await vi.waitFor(() => expect(discord.sent.some((text) => text.endsWith(expected))).toBe(true));
    }
    await secondReport;
    expect(discord.sent).toEqual(["✅ Finished: A", "✅ Finished: B", "✅ Finished: C"]);
    await second.emit("session_shutdown", { reason: "quit" });
  });

  it("rejects a mismatched bridge without delivering buffered input or clearing unrelated bus subscribers", async () => {
    const first = createHarness();
    await first.start(makeAutoStartContext());
    const client = discord.instances[discord.instances.length - 1];
    const sentinel = vi.fn();
    sharedEventBus.on("external:event", sentinel);
    await first.emit("session_shutdown", { reason: "reload" });
    client.emit("messageCreate", {
      author: { bot: false, id: "user-1", username: "tester" },
      member: null,
      channelId: "channel-1",
      content: "must not cross roots",
      react: vi.fn(async () => {}),
      reply: vi.fn(async () => {}),
    });

    const reloadSpecifier = "../index.js?mismatched-buffered-bridge";
    const freshExtension = (await import(reloadSpecifier)).default;
    const second = createHarness(freshExtension);
    const otherContext = {
      ...makeAutoStartContext(),
      cwd: "/other-project",
    };
    await second.emit("session_start", { reason: "reload" }, otherContext);
    expect(client.destroy).toHaveBeenCalledOnce();
    expect(client.listenerCount("messageCreate")).toBe(0);
    expect(client.listenerCount("error")).toBe(0);
    expect(second.pi.sendUserMessage).not.toHaveBeenCalled();
    sharedEventBus.emit("external:event", {});
    expect(sentinel).toHaveBeenCalledOnce();
  });

  it("ignores autoStart on an interactive reload when no bridge exists", async () => {
    vi.mocked(loadEffectiveConfig).mockClear();
    const freshSpecifier = "../index.js?reload-without-bridge";
    const freshExtension = (await import(freshSpecifier)).default;
    const harness = createHarness(freshExtension);
    const before = discord.instances.length;

    await harness.emit("session_start", { reason: "reload" }, makeAutoStartContext());

    expect(discord.instances).toHaveLength(before);
    expect(loadEffectiveConfig).not.toHaveBeenCalled();
  });

  it("does not auto-start a non-interactive reload without a bridge", async () => {
    vi.mocked(loadEffectiveConfig).mockClear();
    const freshSpecifier = "../index.js?headless-reload-without-bridge";
    const freshExtension = (await import(freshSpecifier)).default;
    const harness = createHarness(freshExtension);
    const before = discord.instances.length;

    await harness.emit(
      "session_start",
      { reason: "reload" },
      makeAutoStartContext({ interactive: false }),
    );

    expect(discord.instances).toHaveLength(before);
    expect(loadEffectiveConfig).not.toHaveBeenCalled();
  });

  it("forces a reconnect when the bridged client is not ready after reload", async () => {
    vi.useFakeTimers();
    try {
      const first = createHarness();
      await first.start(makeAutoStartContext());
      const before = discord.instances.length;
      const client = discord.instances[before - 1];
      client.isReady.mockReturnValue(false);

      await first.emit("session_shutdown", { reason: "reload" });

      const second = createHarness();
      await second.emit("session_start", { reason: "reload" }, makeAutoStartContext());
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
      const previousCalls = harness.pi.sendUserMessage.mock.calls.length;
      await messageHandler({
        author: { bot: false, id, username, displayName: names.global },
        member: names.member === undefined ? null : { displayName: names.member },
        channelId: "channel-1",
        content,
        react: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
      });
      await vi.waitFor(() => expect(harness.pi.sendUserMessage.mock.calls.length).toBe(previousCalls + 1));
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

describe("Discord image TUI metadata", () => {
  async function startImageHarness(interactive = true) {
    const harness = createHarness();
    const ctx = makeAutoStartContext({ interactive });
    await harness.start(ctx);
    ctx.ui.notify.mockClear();
    const fetchMock = vi.fn(async (_url: any, _init?: any) => ({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const client = discord.instances[discord.instances.length - 1];
    return { harness, ctx, fetchMock, client };
  }

  it("shows full local path and detected attachment metadata without changing the model result", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-discord-image-"));
    const filePath = join(directory, "photo.jpg");
    await writeFile(filePath, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0xff, 0xd9]));
    const { harness, ctx, fetchMock } = await startImageHarness();
    try {
      const result = await harness.tool("discord_send_image").execute("image", {
        path: filePath,
        channelId: "channel-1",
      }, undefined, undefined, ctx);
      expect(result.content).toEqual([{ type: "text", text: "Image sent to Discord (path)." }]);
      const notification = ctx.ui.notify.mock.calls.map(([text]) => text).join("\n");
      expect(notification).toContain("🖼 Image sent to Discord");
      expect(notification).toContain(`Source: ${filePath}`);
      expect(notification).toContain("Attachment: photo.jpg · image/jpeg · 8 B");
      expect(notification).toContain("Destination: #test-channel");
      const request = fetchMock.mock.calls[0]?.[1] as any;
      const upload = (request.body as FormData).get("files[0]") as Blob;
      expect(upload.type).toBe("image/jpeg");
    } finally {
      await harness.emit("session_shutdown", { reason: "quit" });
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("shows the complete URL locally while keeping it out of the model result", async () => {
    const { harness, ctx } = await startImageHarness();
    const url = "https://example.com/image.png?width=256&signature=test-value";
    try {
      const result = await harness.tool("discord_send_image").execute("image", {
        url,
        channelId: "channel-1",
      }, undefined, undefined, ctx);
      expect(result.content).toEqual([{ type: "text", text: "Image sent to Discord (url)." }]);
      expect(result.content[0].text).not.toContain(url);
      const notification = ctx.ui.notify.mock.calls.map(([text]) => text).join("\n");
      expect(notification).toContain("🖼 Image URL posted to Discord");
      expect(notification).toContain(`Source: ${url}`);
      expect(notification).not.toContain("Attachment:");
    } finally {
      await harness.emit("session_shutdown", { reason: "quit" });
    }
  });

  it("summarizes inline data without displaying its base64 payload", async () => {
    const { harness, ctx } = await startImageHarness();
    const base64 = Buffer.from([1, 2, 3, 4]).toString("base64");
    try {
      await harness.tool("discord_send_image").execute("image", {
        base64,
        mediaType: "image/webp",
        filename: "raw.webp",
        channelId: "channel-1",
      }, undefined, undefined, ctx);
      const notification = ctx.ui.notify.mock.calls.map(([text]) => text).join("\n");
      expect(notification).toContain("Source: inline image data");
      expect(notification).toContain("Attachment: raw.webp · image/webp · 4 B");
      expect(notification).not.toContain(base64);
    } finally {
      await harness.emit("session_shutdown", { reason: "quit" });
    }
  });

  it("reports real disconnection locally without attempting a send", async () => {
    const { harness, ctx, fetchMock, client } = await startImageHarness();
    client.isReady.mockReturnValue(false);
    try {
      const result = await harness.tool("discord_send_image").execute("image", {
        path: "/tmp/not-read.png",
        channelId: "channel-1",
      }, undefined, undefined, ctx);
      expect(result.content[0].text).toContain("discord_not_connected");
      expect(ctx.ui.notify).toHaveBeenCalledWith("⚠ Failed to send image to Discord: discord_not_connected", "error");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await harness.emit("session_shutdown", { reason: "quit" });
    }
  });

  it("does not emit UI notifications in a headless context", async () => {
    const { harness, ctx } = await startImageHarness(false);
    try {
      await harness.tool("discord_send_image").execute("image", {
        url: "https://example.com/image.png",
        channelId: "channel-1",
      }, undefined, undefined, ctx);
      expect(ctx.ui.notify).not.toHaveBeenCalled();
    } finally {
      await harness.emit("session_shutdown", { reason: "quit" });
    }
  });
});
