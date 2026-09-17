import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createSubagentSessionManager } from "#src/session/session-manager";

const temporaryDirectories: string[] = [];

function makeAssistantMessage(): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "child session created" }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  };
}

function mode(path: string): number {
  return statSync(path).mode & 0o7777;
}

function withUmask<T>(umask: number, callback: () => T): T {
  const previousUmask = process.umask(umask);
  try {
    return callback();
  } finally {
    process.umask(previousUmask);
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("createSubagentSessionManager", () => {
  it("creates native child task sessions with traversable owner-only directories under a restrictive umask", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-subagents-session-"));
    temporaryDirectories.push(root);
    const sessionDirectory = join(root, "parent-session");
    const taskDirectory = join(sessionDirectory, "tasks");

    withUmask(0o117, () => {
      const manager = createSubagentSessionManager(root, taskDirectory);

      expect(mode(sessionDirectory)).toBe(0o700);
      expect(mode(taskDirectory)).toBe(0o700);
      const sessionFile = manager.getSessionFile();
      expect(sessionFile).toBeDefined();
      if (!sessionFile) throw new Error("SessionManager did not provide a session file");

      manager.appendMessage(makeAssistantMessage());

      expect(existsSync(sessionFile)).toBe(true);
      expect(readFileSync(sessionFile, "utf8")).toContain("child session created");
    });
  });

  it("adds owner traversal to existing session and task directories without removing permissions", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-subagents-session-"));
    temporaryDirectories.push(root);
    const sessionDirectory = join(root, "parent-session");
    const taskDirectory = join(sessionDirectory, "tasks");
    mkdirSync(taskDirectory, { recursive: true, mode: 0o700 });
    chmodSync(taskDirectory, 0o660);
    chmodSync(sessionDirectory, 0o660);

    const manager = createSubagentSessionManager(root, taskDirectory);

    expect(mode(sessionDirectory)).toBe(0o760);
    expect(mode(taskDirectory)).toBe(0o760);
    const sessionFile = manager.getSessionFile();
    expect(sessionFile).toBeDefined();
    if (!sessionFile) throw new Error("SessionManager did not provide a session file");

    manager.appendMessage(makeAssistantMessage());

    expect(existsSync(sessionFile)).toBe(true);
  });
});
