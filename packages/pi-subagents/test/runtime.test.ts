import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ParentSnapshot } from "#src/lifecycle/parent-snapshot";
import { createSubagentRuntime, SubagentRuntime } from "#src/runtime";
import type { SessionContext } from "#src/types";
import { makeModel } from "#test/helpers/make-model";
import { STUB_SNAPSHOT } from "#test/helpers/stub-ctx";

const mockBuildParentSnapshot = vi.hoisted(() =>
  vi.fn<(ctx: SessionContext, inheritContext?: boolean) => ParentSnapshot>(),
);

vi.mock("#src/lifecycle/parent-snapshot", () => ({
  buildParentSnapshot: mockBuildParentSnapshot,
}));

function makeSessionCtx(overrides?: Partial<SessionContext>): SessionContext {
  return {
    cwd: "/test/cwd",
    model: undefined,
    modelRegistry: { find: () => undefined, getAll: () => [] },
    getSystemPrompt: () => "test prompt",
    sessionManager: {
      getSessionFile: () => "/sessions/test.jsonl",
      getSessionId: () => "test-session-id",
      getBranch: () => [],
    },
    ...overrides,
  };
}

function makeAssistantToolCallMessage(toolCallIds: readonly string[]): AssistantMessage {
  return {
    role: "assistant",
    content: toolCallIds.map((id) => ({
      type: "toolCall",
      id,
      name: "subagent",
      arguments: {},
    })),
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
    stopReason: "toolUse",
    timestamp: 0,
  };
}

describe("createSubagentRuntime", () => {
  it("returns correct defaults", () => {
    const runtime = createSubagentRuntime();
    expect(runtime.currentCtx).toBeUndefined();
  });

  it("currentCtx is the stored SessionContext after setSessionContext", () => {
    const runtime = createSubagentRuntime();
    const ctx = makeSessionCtx();
    runtime.setSessionContext(ctx);
    expect(runtime.currentCtx).toBe(ctx);
  });
});

describe("SubagentRuntime class", () => {
  it("is a class — instances are created with new", () => {
    const runtime = new SubagentRuntime();
    expect(runtime).toBeInstanceOf(SubagentRuntime);
  });

  it("createSubagentRuntime returns an instance of the class", () => {
    const runtime = createSubagentRuntime();
    expect(runtime).toBeInstanceOf(SubagentRuntime);
  });
});

describe("SubagentRuntime session-context methods", () => {
  it("setSessionContext stores the provided SessionContext directly", () => {
    const runtime = createSubagentRuntime();
    const ctx = makeSessionCtx();
    runtime.setSessionContext(ctx);
    expect(runtime.currentCtx).toBe(ctx);
  });

  it("clearSessionContext resets currentCtx to undefined", () => {
    const runtime = createSubagentRuntime();
    runtime.setSessionContext(makeSessionCtx());
    expect(runtime.currentCtx).toBeDefined();
    runtime.clearSessionContext();
    expect(runtime.currentCtx).toBeUndefined();
  });

  it("round-trip: set then clear returns to initial state", () => {
    const runtime = createSubagentRuntime();
    expect(runtime.currentCtx).toBeUndefined();
    const ctx = makeSessionCtx();
    runtime.setSessionContext(ctx);
    expect(runtime.currentCtx).toBe(ctx);
    runtime.clearSessionContext();
    expect(runtime.currentCtx).toBeUndefined();
  });
});

describe("SubagentRuntime service parent binding", () => {
  it("uses the active session's persisted leaf without a tool-call fallback", () => {
    const runtime = createSubagentRuntime();
    runtime.setSessionContext(makeSessionCtx({
      sessionManager: {
        getSessionFile: () => "/sessions/parent.jsonl",
        getSessionId: () => "owner-session-id",
        getLeafId: () => "persisted-leaf-entry-id",
        getBranch: () => [],
      },
    }));

    const binding = runtime.getServiceParentSessionInfo();

    expect(binding).toEqual({
      parentSessionFile: "/sessions/parent.jsonl",
      parentSessionId: "owner-session-id",
      parentEntryId: "persisted-leaf-entry-id",
    });
    expect(binding).not.toHaveProperty("toolCallId");
    expect(Object.isFrozen(binding)).toBe(true);
  });

  it("rejects an active context without a session ID", () => {
    const runtime = createSubagentRuntime();
    runtime.setSessionContext(makeSessionCtx({
      sessionManager: {
        getSessionFile: () => "/sessions/parent.jsonl",
        getSessionId: () => "",
        getLeafId: () => "persisted-leaf-entry-id",
        getBranch: () => [],
      },
    }));

    expect(() => runtime.getServiceParentSessionInfo()).toThrow(
      "Cannot spawn a V2-tracked subagent without an active parent session.",
    );
  });

  it("rejects an active session without a persisted leaf", () => {
    const runtime = createSubagentRuntime();
    runtime.setSessionContext(makeSessionCtx({
      sessionManager: {
        getSessionFile: () => "/sessions/parent.jsonl",
        getSessionId: () => "owner-session-id",
        getLeafId: () => null,
        getBranch: () => [],
      },
    }));

    expect(() => runtime.getServiceParentSessionInfo()).toThrow(
      "Cannot spawn a V2-tracked subagent without a persisted parent session entry.",
    );
  });
});

describe("SubagentRuntime tool parent binding", () => {
  it("binds either tool call to its persisted assistant entry after a later custom entry", () => {
    const sessionManager = SessionManager.inMemory("/test/cwd", { id: "owner-session" });
    const assistantEntryId = sessionManager.appendMessage(
      makeAssistantToolCallMessage(["tool-call-one", "tool-call-two"]),
    );
    const laterCustomEntryId = sessionManager.appendCustomEntry("test.custom", { marker: "later" });
    const runtime = createSubagentRuntime();
    runtime.setSessionContext(makeSessionCtx({ sessionManager }));

    const firstBinding = runtime.getToolParentSessionInfo("tool-call-one");
    const secondBinding = runtime.getToolParentSessionInfo("tool-call-two");

    expect(firstBinding).toEqual({
      parentSessionFile: "",
      parentSessionId: "owner-session",
      parentEntryId: assistantEntryId,
      toolCallId: "tool-call-one",
    });
    expect(secondBinding).toEqual({
      parentSessionFile: "",
      parentSessionId: "owner-session",
      parentEntryId: assistantEntryId,
      toolCallId: "tool-call-two",
    });
    expect(secondBinding.parentEntryId).not.toBe(laterCustomEntryId);
    expect(secondBinding.parentEntryId).not.toBe("tool-call-two");
    expect(Object.isFrozen(secondBinding)).toBe(true);
  });

  it("fails without a matching assistant tool entry instead of returning a leaf, task, or run id", () => {
    const sessionManager = SessionManager.inMemory("/test/cwd", { id: "owner-session" });
    sessionManager.appendMessage(makeAssistantToolCallMessage(["another-tool-call"]));
    sessionManager.appendCustomEntry("test.custom", { marker: "leaf" });
    const runtime = createSubagentRuntime();
    runtime.setSessionContext(makeSessionCtx({ sessionManager }));

    expect(() => runtime.getToolParentSessionInfo("missing-tool-call")).toThrow(
      "Cannot spawn a subagent without a matching persisted assistant entry for the current tool call.",
    );
  });
});

describe("SubagentRuntime context query methods", () => {
  beforeEach(() => {
    mockBuildParentSnapshot.mockReset();
  });

  it("buildSnapshot delegates to buildParentSnapshot with the current context and inheritContext flag", () => {
    const runtime = createSubagentRuntime();
    const ctx = makeSessionCtx();
    runtime.setSessionContext(ctx);
    mockBuildParentSnapshot.mockReturnValueOnce(STUB_SNAPSHOT);
    const result = runtime.buildSnapshot(true);
    expect(mockBuildParentSnapshot).toHaveBeenCalledWith(ctx, true);
    expect(result).toBe(STUB_SNAPSHOT);
  });

  it("buildSnapshot passes false inheritContext correctly", () => {
    const runtime = createSubagentRuntime();
    const ctx = makeSessionCtx();
    runtime.setSessionContext(ctx);
    mockBuildParentSnapshot.mockReturnValueOnce(STUB_SNAPSHOT);
    runtime.buildSnapshot(false);
    expect(mockBuildParentSnapshot).toHaveBeenCalledWith(ctx, false);
  });

  it("getModelInfo returns model and modelRegistry from current context", () => {
    const runtime = createSubagentRuntime();
    const registry = { find: () => undefined, getAll: () => [], getAvailable: () => [] };
    const model = makeModel({ id: "claude-sonnet", name: "Claude Sonnet" });
    const ctx = makeSessionCtx({ model, modelRegistry: registry });
    runtime.setSessionContext(ctx);
    const info = runtime.getModelInfo();
    expect(info.parentModel).toBe(model);
    expect(info.modelRegistry).toBe(registry);
  });

  it("getModelInfo returns undefined parentModel when context model is undefined", () => {
    const runtime = createSubagentRuntime();
    const ctx = makeSessionCtx({ model: undefined });
    runtime.setSessionContext(ctx);
    const info = runtime.getModelInfo();
    expect(info.parentModel).toBeUndefined();
  });

  it("getSessionInfo returns session file and id from sessionManager", () => {
    const runtime = createSubagentRuntime();
    const ctx = makeSessionCtx({
      sessionManager: {
        getSessionFile: () => "/sessions/parent.jsonl",
        getSessionId: () => "session-42",
        getBranch: () => [],
      },
    });
    runtime.setSessionContext(ctx);
    const info = runtime.getSessionInfo();
    expect(info.parentSessionFile).toBe("/sessions/parent.jsonl");
    expect(info.parentSessionId).toBe("session-42");
  });

  it("getSessionInfo uses empty string when getSessionFile returns undefined", () => {
    const runtime = createSubagentRuntime();
    const ctx = makeSessionCtx({
      sessionManager: {
        getSessionFile: () => undefined,
        getSessionId: () => "session-99",
        getBranch: () => [],
      },
    });
    runtime.setSessionContext(ctx);
    const info = runtime.getSessionInfo();
    expect(info.parentSessionFile).toBe("");
    expect(info.parentSessionId).toBe("session-99");
  });
});
