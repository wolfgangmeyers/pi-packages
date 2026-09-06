import { type AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SubagentSession } from "#src/lifecycle/subagent-session";
import type { ControlResultPayloadV1 } from "#src/types";
import { createChildLifecycleMock } from "#test/helpers/subagent-session-io";

// ── Session mock factory ───────────────────────────────────────────────────────

/**
 * Subscribable session stub whose `prompt()` appends a final assistant message.
 * `listeners` lets tests drive turn_end events for turn-limit assertions.
 */
function createSession(finalText: string) {
  const listeners: Array<(event: any) => void> = [];
  const session = {
    messages: [] as unknown[],
    sessionManager: SessionManager.inMemory(),
    subscribe: vi.fn((listener: (event: any) => void) => {
      listeners.push(listener);
      return () => {};
    }),
    prompt: vi.fn(async () => {
      session.messages.push({
        role: "assistant",
        content: [{ type: "text", text: finalText }],
      });
    }),
    abort: vi.fn(),
    steer: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    getSessionStats: vi.fn(() => ({
      tokens: { input: 100, output: 50, cacheWrite: 10 },
      contextUsage: { percent: 42 },
    })),
    getToolDefinition: vi.fn((_name: string): unknown => undefined),
    sendCustomMessage: vi.fn().mockResolvedValue(undefined),
  };
  return { session, listeners };
}

function emitTurnEnd(listeners: Array<(e: any) => void>) {
  for (const l of listeners) l({ type: "turn_end" });
}

/**
 * Program session.prompt to emit `turns` turn_end events, then settle the run
 * with a final assistant message. The turn count is the meaningful input that
 * drives the steer/abort boundary each turn-limit test asserts on.
 */
function programTurns(
  session: ReturnType<typeof createSession>["session"],
  listeners: ReturnType<typeof createSession>["listeners"],
  turns: number,
  finalText = "done",
) {
  session.prompt = vi.fn(async () => {
    for (let i = 0; i < turns; i++) emitTurnEnd(listeners);
    session.messages.push({ role: "assistant", content: [{ type: "text", text: finalText }] });
  });
}

/** Build a SubagentSession around a session stub with default meta. */
function makeSubagentSession(
  session: ReturnType<typeof createSession>["session"],
  metaOverrides?: Partial<{
    outputFile: string | undefined;
    sessionId: string;
    sessionDir: string;
    agentName: string;
    agentMaxTurns: number | undefined;
    parentContext: string | undefined;
    lifecycle: ReturnType<typeof createChildLifecycleMock>;
  }>,
) {
  const lifecycle = metaOverrides?.lifecycle ?? createChildLifecycleMock();
  const hasOutputFile = metaOverrides != null && "outputFile" in metaOverrides;
  const sub = new SubagentSession(session as unknown as AgentSession, {
    outputFile: hasOutputFile ? metaOverrides.outputFile : "/sessions/child.jsonl",
    sessionId: metaOverrides?.sessionId ?? "child-session-default",
    sessionDir: metaOverrides?.sessionDir ?? "/sessions/dir",
    agentName: metaOverrides?.agentName ?? "Plan",
    agentMaxTurns: metaOverrides?.agentMaxTurns,
    parentContext: metaOverrides?.parentContext,
    lifecycle,
  });
  return { sub, lifecycle };
}

let lifecycle: ReturnType<typeof createChildLifecycleMock>;

beforeEach(() => {
  lifecycle = createChildLifecycleMock();
});

describe("SubagentSession — accessors", () => {
  it("exposes the wrapped session and outputFile", () => {
    const { session } = createSession("X");
    const { sub } = makeSubagentSession(session, { outputFile: "/out.jsonl" });
    expect(sub.session).toBe(session);
    expect(sub.outputFile).toBe("/out.jsonl");
  });

  it("returns undefined outputFile when none was persisted", () => {
    const { session } = createSession("X");
    const { sub } = makeSubagentSession(session, { outputFile: undefined });
    expect(sub.outputFile).toBeUndefined();
  });
});

describe("SubagentSession — runTurnLoop response capture", () => {
  it("returns the final assistant text even when no text_delta events streamed", async () => {
    const { session } = createSession("LOCKED");
    const { sub } = makeSubagentSession(session);
    const result = await sub.runTurnLoop("Say LOCKED", {});
    expect(result.responseText).toBe("LOCKED");
  });

  it("captures streamed text_delta events as the response", async () => {
    const { session, listeners } = createSession("FALLBACK");
    session.prompt = vi.fn(async () => {
      for (const l of listeners) {
        l({ type: "message_start" });
        l({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello " } });
        l({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "world" } });
      }
    });
    const { sub } = makeSubagentSession(session);
    const result = await sub.runTurnLoop("go", {});
    expect(result.responseText).toBe("hello world");
  });

  it("prepends parentContext to the prompt", async () => {
    const { session } = createSession("DONE");
    const { sub } = makeSubagentSession(session, { parentContext: "CTX\n" });
    await sub.runTurnLoop("the task", {});
    expect(session.prompt).toHaveBeenCalledWith("CTX\nthe task");
  });
});

describe("SubagentSession — runTurnLoop turn limits", () => {
  it("steers at the soft limit and aborts after the grace window", async () => {
    const { session, listeners } = createSession("done");
    programTurns(session, listeners, 3);
    const { sub } = makeSubagentSession(session);
    const result = await sub.runTurnLoop("go", { maxTurns: 2, graceTurns: 1 });
    expect(session.steer).toHaveBeenCalledWith(expect.stringContaining("turn limit"));
    expect(session.abort).toHaveBeenCalled();
    expect(result.aborted).toBe(true);
    expect(result.steered).toBe(true);
  });

  it("graceTurns extends the window so a finishing agent is not aborted", async () => {
    const { session, listeners } = createSession("done");
    programTurns(session, listeners, 3);
    const { sub } = makeSubagentSession(session);
    const result = await sub.runTurnLoop("go", { maxTurns: 1, graceTurns: 3 });
    expect(result.steered).toBe(true);
    expect(result.aborted).toBe(false);
    expect(session.abort).not.toHaveBeenCalled();
  });

  it("per-call maxTurns takes precedence over agentMaxTurns and defaultMaxTurns", async () => {
    const { session, listeners } = createSession("done");
    programTurns(session, listeners, 2);
    const { sub } = makeSubagentSession(session, { agentMaxTurns: 1 });
    await sub.runTurnLoop("go", { maxTurns: 3, defaultMaxTurns: 1, graceTurns: 1 });
    expect(session.steer).not.toHaveBeenCalled();
    expect(session.abort).not.toHaveBeenCalled();
  });

  it("falls back to agentMaxTurns when no per-call maxTurns is set", async () => {
    const { session, listeners } = createSession("done");
    programTurns(session, listeners, 1);
    const { sub } = makeSubagentSession(session, { agentMaxTurns: 1 });
    const result = await sub.runTurnLoop("go", { defaultMaxTurns: 9 });
    expect(session.steer).toHaveBeenCalledWith(expect.stringContaining("turn limit"));
    expect(result.steered).toBe(true);
  });

  it("falls back to defaultMaxTurns when neither per-call nor agentMaxTurns is set", async () => {
    const { session, listeners } = createSession("done");
    programTurns(session, listeners, 1);
    const { sub } = makeSubagentSession(session);
    const result = await sub.runTurnLoop("go", { defaultMaxTurns: 1, graceTurns: 5 });
    expect(session.steer).toHaveBeenCalledWith(expect.stringContaining("turn limit"));
    expect(result.steered).toBe(true);
  });
});

describe("SubagentSession — runTurnLoop parent abort signal", () => {
  it("aborts the session when the parent signal fires mid-prompt", async () => {
    const controller = new AbortController();
    const { session } = createSession("X");
    // prompt stays in flight until the parent signal aborts.
    session.prompt = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          controller.signal.addEventListener("abort", () => resolve(), { once: true });
        }),
    );
    const { sub } = makeSubagentSession(session);
    const promise = sub.runTurnLoop("go", { signal: controller.signal });
    controller.abort();
    await promise;
    expect(session.abort).toHaveBeenCalled();
  });

  it("does not abort the session when the parent signal never fires", async () => {
    const controller = new AbortController();
    const { session } = createSession("X");
    const { sub } = makeSubagentSession(session);
    await sub.runTurnLoop("go", { signal: controller.signal });
    expect(session.abort).not.toHaveBeenCalled();
  });
});

describe("SubagentSession — runTurnLoop lifecycle events", () => {
  it("emits completed with the run outcome on the success path", async () => {
    const { session } = createSession("OK");
    const { sub } = makeSubagentSession(session, { sessionDir: "/d", agentName: "Plan", lifecycle });
    await sub.runTurnLoop("go", {});
    expect(lifecycle.completed).toHaveBeenCalledOnce();
    expect(lifecycle.completed).toHaveBeenCalledWith({
      sessionDir: "/d",
      agentName: "Plan",
      aborted: false,
      steered: false,
    });
  });

  it("does not emit disposed from runTurnLoop (disposal is separate)", async () => {
    const { session } = createSession("OK");
    const { sub } = makeSubagentSession(session, { lifecycle });
    await sub.runTurnLoop("go", {});
    expect(lifecycle.disposed).not.toHaveBeenCalled();
  });

  it("skips completed when prompt throws and does not emit disposed", async () => {
    const { session } = createSession("OK");
    session.prompt = vi.fn().mockRejectedValue(new Error("prompt failed"));
    const { sub } = makeSubagentSession(session, { lifecycle });
    await expect(sub.runTurnLoop("go", {})).rejects.toThrow("prompt failed");
    expect(lifecycle.completed).not.toHaveBeenCalled();
    expect(lifecycle.disposed).not.toHaveBeenCalled();
  });
});

describe("SubagentSession — resumeTurnLoop", () => {
  it("re-prompts the session and returns the final assistant text", async () => {
    const { session } = createSession("RESUMED");
    const { sub } = makeSubagentSession(session);
    const text = await sub.resumeTurnLoop("Continue");
    expect(session.prompt).toHaveBeenCalledWith("Continue");
    expect(text).toBe("RESUMED");
  });

  it("does not emit completed or disposed", async () => {
    const { session } = createSession("RESUMED");
    const { sub } = makeSubagentSession(session, { lifecycle });
    await sub.resumeTurnLoop("Continue");
    expect(lifecycle.completed).not.toHaveBeenCalled();
    expect(lifecycle.disposed).not.toHaveBeenCalled();
  });
});

describe("SubagentSession — steer", () => {
  it("delegates the message to the live session", async () => {
    const { session } = createSession("X");
    const { sub } = makeSubagentSession(session);
    await sub.steer("hurry up");
    expect(session.steer).toHaveBeenCalledWith("hurry up");
  });
});

describe("SubagentSession — delegate methods", () => {
  it("getConversation returns formatted text from session messages", () => {
    const { session } = createSession("X");
    session.messages.push({ role: "user", content: "Hello" });
    session.messages.push({
      role: "assistant",
      content: [{ type: "text", text: "World" }],
    });
    const { sub } = makeSubagentSession(session);
    const conv = sub.getConversation();
    expect(conv).toContain("[User]: Hello");
    expect(conv).toContain("[Assistant");
    expect(conv).toContain("World");
  });

  it("getContextPercent returns the session context percent", () => {
    const { session } = createSession("X");
    const { sub } = makeSubagentSession(session);
    expect(sub.getContextPercent()).toBe(42);
  });

  it("getContextPercent returns null when getSessionStats is unavailable", () => {
    const { session } = createSession("X");
    session.getSessionStats = vi.fn(() => { throw new Error("no stats"); });
    const { sub } = makeSubagentSession(session);
    expect(sub.getContextPercent()).toBeNull();
  });

  it("subscribe delegates to the underlying session", () => {
    const { session } = createSession("X");
    const { sub } = makeSubagentSession(session);
    const fn = vi.fn();
    const unsub = sub.subscribe(fn);
    expect(session.subscribe).toHaveBeenCalledWith(fn);
    expect(typeof unsub).toBe("function");
  });

  it("getSessionStats delegates to the underlying session", () => {
    const { session } = createSession("X");
    const { sub } = makeSubagentSession(session);
    const stats = sub.getSessionStats();
    expect(session.getSessionStats).toHaveBeenCalled();
    expect(stats.tokens.input).toBe(100);
  });

  it("messages returns the underlying session messages", () => {
    const { session } = createSession("X");
    session.messages.push({ role: "user", content: "hi" });
    const { sub } = makeSubagentSession(session);
    expect(sub.messages).toBe(session.messages);
  });

  it("agentMessages returns the underlying session messages typed", () => {
    const { session } = createSession("X");
    session.messages.push({ role: "user", content: "hi" });
    const { sub } = makeSubagentSession(session);
    expect(sub.agentMessages).toBe(session.messages);
  });

  it("getToolDefinition delegates to the underlying session", () => {
    const { session } = createSession("X");
    const def = { name: "read" };
    session.getToolDefinition = vi.fn(() => def);
    const { sub } = makeSubagentSession(session);
    expect(sub.getToolDefinition("read")).toBe(def);
    expect(session.getToolDefinition).toHaveBeenCalledWith("read");
  });
});

function makeControlResultPayload(): ControlResultPayloadV1 {
  return {
    protocol: "mecha.control/v1",
    result_id: "00000000-0000-4000-8000-000000000001",
    request_id: "00000000-0000-4000-8000-000000000002",
    target_session_epoch: 1,
    runtime_generation: "00000000-0000-4000-8000-000000000003",
    manifest_sha256: "a".repeat(64),
    status: "ok",
    content: "Control completed.",
    details: { operation: "test" },
  };
}

describe("SubagentSession — control results", () => {
  it("uses AgentSession.sendCustomMessage with the exact hidden model-visible shape", async () => {
    const { session } = createSession("X");
    const { sub } = makeSubagentSession(session);
    const payload = makeControlResultPayload();

    await sub.appendControlResult(payload);

    expect(session.sendCustomMessage).toHaveBeenCalledExactlyOnceWith({
      customType: "mecha.control.result.v1",
      content: payload.content,
      display: false,
      details: {
        protocol: payload.protocol,
        result_id: payload.result_id,
        request_id: payload.request_id,
        target_session_epoch: payload.target_session_epoch,
        runtime_generation: payload.runtime_generation,
        manifest_sha256: payload.manifest_sha256,
        status: payload.status,
        details: payload.details,
      },
    }, { triggerTurn: false });
  });

  it("omits error for ok and includes only the closed error object for error", async () => {
    const { session } = createSession("X");
    const { sub } = makeSubagentSession(session);
    const payload = {
      ...makeControlResultPayload(),
      status: "error" as const,
      error: { code: "HANDLER_FAILED", message: "The handler failed.", retryable: true },
    };

    await sub.appendControlResult(payload);

    expect(session.sendCustomMessage).toHaveBeenCalledWith(expect.objectContaining({
      details: {
        protocol: payload.protocol,
        result_id: payload.result_id,
        request_id: payload.request_id,
        target_session_epoch: payload.target_session_epoch,
        runtime_generation: payload.runtime_generation,
        manifest_sha256: payload.manifest_sha256,
        status: "error",
        details: payload.details,
        error: payload.error,
      },
    }), { triggerTurn: false });
    expect(session.sendCustomMessage.mock.calls[0]?.[1]).not.toHaveProperty("deliverAs");
  });

  it("finds a persisted control result on the exact child branch after compaction rebuilds model context", () => {
    const { session } = createSession("X");
    const payload = makeControlResultPayload();
    session.sessionManager.appendCustomMessageEntry("other", "before", false);
    session.sessionManager.appendCustomMessageEntry(
      "mecha.control.result.v1",
      payload.content,
      false,
      {
        protocol: payload.protocol,
        result_id: payload.result_id,
        request_id: payload.request_id,
        target_session_epoch: payload.target_session_epoch,
        runtime_generation: payload.runtime_generation,
        manifest_sha256: payload.manifest_sha256,
        status: payload.status,
        details: payload.details,
      },
    );
    const firstKeptEntryId = session.sessionManager.appendCustomMessageEntry("other", "after", false);
    session.sessionManager.appendCompaction("summary", firstKeptEntryId, 1);
    session.messages = [...session.sessionManager.buildSessionContext().messages];
    const { sub } = makeSubagentSession(session);

    expect(sub.findControlResultById(payload.result_id)).toEqual(payload);
    expect(sub.findControlResultById("00000000-0000-4000-8000-000000000099")).toBeUndefined();
  });

  it("leaves stream deferral and message_end ordering to AgentSession", async () => {
    const { session, listeners } = createSession("X");
    const deferred: Array<Record<string, unknown>> = [];
    let streaming = true;
    session.sendCustomMessage.mockImplementation(async (message: Record<string, unknown>, options: { triggerTurn?: boolean }) => {
      expect(options).toEqual({ triggerTurn: false });
      if (streaming) {
        deferred.push(message);
        return;
      }
      session.messages.push({ role: "custom", ...message });
      for (const listener of listeners) listener({ type: "message_end", message: session.messages.at(-1) });
    });
    const { sub } = makeSubagentSession(session);
    const payload = makeControlResultPayload();
    const messageEnds: unknown[] = [];
    sub.subscribe((event) => {
      if (event.type === "message_end") messageEnds.push(event.message);
    });

    await sub.appendControlResult(payload);
    expect(session.messages).toEqual([]);
    expect(deferred).toHaveLength(1);

    streaming = false;
    await session.sendCustomMessage(deferred[0], { triggerTurn: false });
    expect(session.messages).toEqual([{
      role: "custom",
      customType: "mecha.control.result.v1",
      content: payload.content,
      display: false,
      details: expect.objectContaining({ result_id: payload.result_id }),
    }]);
    expect(messageEnds).toHaveLength(1);
  });
});

describe("SubagentSession — dispose", () => {
  it("disposes the session and emits disposed with the child session id", () => {
    const { session } = createSession("X");
    const { sub } = makeSubagentSession(session, { sessionId: "child-session-abc", lifecycle });
    sub.dispose();
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(lifecycle.disposed).toHaveBeenCalledOnce();
    expect(lifecycle.disposed).toHaveBeenCalledWith({ sessionId: "child-session-abc" });
  });
});
