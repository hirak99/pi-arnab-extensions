import { describe, it, expect } from "vitest";
import {
  makeChannelName,
  makeStaticChannelName,
  splitMessage,
  toolLabel,
  isAbortLikeError,
  sleep,
  withTimeout,
} from "../helpers.js";

// ─── makeChannelName ──────────────────────────────────────────────────────────

describe("makeChannelName", () => {
  it("uses the basename of cwd", () => {
    const name = makeChannelName("/home/user/my-project");
    expect(name).toMatch(/^my-project-/);
  });

  it("falls back to 'pi' for empty basename", () => {
    const name = makeChannelName("/");
    expect(name).toMatch(/^pi-/);
  });

  it("lowercases everything", () => {
    const name = makeChannelName("/path/MyApp");
    expect(name).toBe(name.toLowerCase());
  });

  it("replaces non-alphanumeric chars with dashes", () => {
    const name = makeChannelName("/path/hello world!");
    // Only a-z, 0-9, - and _ should remain
    expect(name).not.toContain(" ");
    expect(name).not.toContain("!");
  });

  it("collapses multiple dashes", () => {
    const name = makeChannelName("/path/foo---bar");
    expect(name).not.toContain("---");
    expect(name).not.toMatch(/--/);
  });

  it("trims leading/trailing dashes", () => {
    const name = makeChannelName("/path/-hello-");
    expect(name).not.toMatch(/^-|-$/);
  });

  it("truncates to 100 chars max", () => {
    const name = makeChannelName("/a/" + "x".repeat(200));
    expect(name.length).toBeLessThanOrEqual(100);
  });

  it("includes month+day+time in the suffix", () => {
    const name = makeChannelName("/my-project");
    // Should match pattern like "my-project-may18-1430"
    expect(name).toMatch(/^my-project-[a-z]{3}\d{2}-\d{4}$/);
  });
});

// ─── makeStaticChannelName ────────────────────────────────────────────────────

describe("makeStaticChannelName", () => {
  it("uses the slugified basename of cwd with no date suffix", () => {
    expect(makeStaticChannelName("/home/user/My Project")).toBe("my-project");
  });

  it("prefers an explicit channelName over the directory name", () => {
    expect(makeStaticChannelName("/home/user/whatever", "Hermes Agents")).toBe("hermes-agents");
  });

  it("falls back to 'pi' for an empty basename", () => {
    expect(makeStaticChannelName("/")).toBe("pi");
  });

  it("falls back to 'pi' when the explicit name slugs to nothing", () => {
    expect(makeStaticChannelName("/x", "!!!")).toBe("pi");
  });

  it("treats a whitespace-only explicit name as unset", () => {
    expect(makeStaticChannelName("/home/user/proj", "   ")).toBe("proj");
  });

  it("truncates to 100 chars max", () => {
    expect(makeStaticChannelName("/a/" + "x".repeat(200)).length).toBeLessThanOrEqual(100);
  });

  it("is stable across calls (no time component)", () => {
    const a = makeStaticChannelName("/home/user/proj");
    const b = makeStaticChannelName("/home/user/proj");
    expect(a).toBe(b);
  });
});

// ─── splitMessage ─────────────────────────────────────────────────────────────

describe("splitMessage", () => {
  it("returns a single chunk for short text", () => {
    const result = splitMessage("hello", 1900);
    expect(result).toEqual(["hello"]);
  });

  it("splits at newline boundaries when possible", () => {
    const line = "a".repeat(100);
    const text = `${line}\n${line}\n${line}`; // 302 chars
    const chunks = splitMessage(text, 150);
    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk should start with content, not a bare newline
    for (const chunk of chunks) {
      expect(chunk).not.toMatch(/^\n/);
    }
  });

  it("hard-splits when no newline is found within maxLen", () => {
    const text = "a".repeat(300);
    const chunks = splitMessage(text, 100);
    expect(chunks.length).toBe(3);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(100);
    }
  });

  it("reassembles to the original text", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `Line ${i}: ${"x".repeat(40)}`);
    const text = lines.join("\n");
    const chunks = splitMessage(text, 200);
    // Reassembly should be close — split strips leading newlines from chunk boundaries
    const reassembled = chunks.join("\n");
    // The text content should be preserved (newlines may differ slightly at boundaries)
    expect(reassembled.replace(/\n+/g, "\n")).toBe(text.replace(/\n+/g, "\n"));
  });

  it("handles empty string", () => {
    expect(splitMessage("", 1900)).toEqual([""]);
  });

  it("respects custom maxLen", () => {
    const text = "a".repeat(50);
    expect(splitMessage(text, 100)).toEqual([text]);
    expect(splitMessage(text, 10).length).toBeGreaterThan(1);
  });
});

// ─── toolLabel ────────────────────────────────────────────────────────────────

describe("toolLabel", () => {
  it("uses mapped emoji for known tools", () => {
    expect(toolLabel("bash", { command: "ls" })).toContain("🔧");
    expect(toolLabel("read", { path: "/foo" })).toContain("📄");
    expect(toolLabel("edit", { path: "/foo" })).toContain("✏️");
    expect(toolLabel("write", { path: "/foo" })).toContain("📝");
    expect(toolLabel("grep", { pattern: "TODO" })).toContain("🔍");
  });

  it("uses gear emoji for unknown tools", () => {
    expect(toolLabel("custom_tool", {})).toContain("⚙️");
  });

  it("summarizes bash without exposing the command", () => {
    const label = toolLabel("bash", { command: "echo sensitive-input" });
    expect(label).toBe("🔧 running a command");
    expect(label).not.toContain("sensitive-input");
  });

  it("shows paths for read/write/edit", () => {
    expect(toolLabel("read", { path: "/src/index.ts" })).toBe("📄 reading `/src/index.ts`");
    expect(toolLabel("write", { path: "/out.txt" })).toBe("📝 writing to `/out.txt`");
    expect(toolLabel("edit", { path: "/edit.ts" })).toBe("✏️ editing `/edit.ts`");
  });

  it("shows only the path for grep, not the search pattern", () => {
    const label = toolLabel("grep", { pattern: "sensitive-pattern", path: "/src" });
    expect(label).toBe("🔍 searching in `/src`");
    expect(label).not.toContain("sensitive-pattern");
  });

  it("shows paths for find and ls", () => {
    expect(toolLabel("find", { path: "/workspace" })).toBe("🔎 finding files in `/workspace`");
    expect(toolLabel("ls", { path: "/workspace" })).toBe("📁 listing `/workspace`");
  });

  it("handles null/undefined args gracefully", () => {
    expect(toolLabel("bash", null)).toBe("🔧 running a command");
    expect(toolLabel("write", undefined)).toBe("📝 writing to");
  });
});

// ─── isAbortLikeError ─────────────────────────────────────────────────────────

describe("isAbortLikeError", () => {
  it("detects 'aborted' in message", () => {
    expect(isAbortLikeError(new Error("Request aborted"))).toBe(true);
    expect(isAbortLikeError(new Error("aborted by user"))).toBe(true);
  });

  it("detects 'abort' in message", () => {
    expect(isAbortLikeError(new Error("Abort signal"))).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isAbortLikeError(new Error("ABORTED"))).toBe(true);
    expect(isAbortLikeError(new Error("AbOrT"))).toBe(true);
  });

  it("returns false for non-abort errors", () => {
    expect(isAbortLikeError(new Error("Network timeout"))).toBe(false);
    expect(isAbortLikeError(new Error("File not found"))).toBe(false);
  });

  it("handles non-Error objects", () => {
    expect(isAbortLikeError("string error")).toBe(false);
    expect(isAbortLikeError(null)).toBe(false);
    expect(isAbortLikeError(undefined)).toBe(false);
    expect(isAbortLikeError({})).toBe(false);
  });
});

// ─── sleep ────────────────────────────────────────────────────────────────────

describe("sleep", () => {
  it("resolves after the given duration", async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40); // allow minor variance
  });

  it("resolves with undefined", async () => {
    const result = await sleep(1);
    expect(result).toBeUndefined();
  });
});

// ─── withTimeout ──────────────────────────────────────────────────────────────

describe("withTimeout", () => {
  it("resolves when the promise finishes in time", async () => {
    const result = await withTimeout(Promise.resolve(42), 1000, "test");
    expect(result).toBe(42);
  });

  it("rejects with timeout error when promise is too slow", async () => {
    const slow = new Promise(() => {}); // never resolves
    await expect(withTimeout(slow, 50, "slow_op")).rejects.toThrow("timeout:slow_op:50ms");
  });

  it("preserves the original rejection reason", async () => {
    const fail = new Promise((_resolve, reject) => reject(new Error("boom")));
    await expect(withTimeout(fail, 1000, "test")).rejects.toThrow("boom");
  });

  it("cleans up the timer on success", async () => {
    // Should not throw or leak — just verifies no unhandled timer
    await withTimeout(Promise.resolve("ok"), 10_000, "timer_cleanup");
  });
});
