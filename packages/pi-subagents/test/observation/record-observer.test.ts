import { afterEach, describe, expect, it, vi } from "vitest";
import { SubagentState } from "#src/lifecycle/subagent-state";
import { subscribeSubagentObserver } from "#src/observation/record-observer";
import type { CompactionTransitionV2 } from "#src/types";
import { createMockSession } from "#test/helpers/mock-session";

function makeState() {
  return new SubagentState({ status: "running" });
}

describe("subscribeSubagentObserver", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("compaction transitions", () => {
    it("emits explicit source transitions in order while preserving successful legacy behavior", () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      const session = createMockSession();
      const state = makeState();
      const transitions: CompactionTransitionV2[] = [];
      const onCompact = vi.fn();
      subscribeSubagentObserver(session, state, {
        onCompactionTransition: (transition) => transitions.push(transition),
        onCompact,
      });

      session.emit({ type: "compaction_start", reason: "threshold" });
      session.emit({
        type: "compaction_end",
        aborted: false,
        result: { tokensBefore: 12_345 },
        reason: "threshold",
      });
      session.emit({
        type: "compaction_end",
        aborted: false,
        errorMessage: "summary request failed",
        reason: "overflow",
      });
      session.emit({ type: "compaction_end", aborted: true, reason: "manual" });

      expect(transitions).toEqual([
        { type: "start", started_at: "1970-01-01T00:00:01.000Z" },
        { type: "completed" },
        { type: "failed" },
        { type: "aborted" },
      ]);
      expect(state.compactionCount).toBe(1);
      expect(onCompact).toHaveBeenCalledExactlyOnceWith({ reason: "threshold", tokensBefore: 12_345 });
    });

    it("does not emit a terminal transition or invent an outcome when compaction has no end", () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      const session = createMockSession();
      const state = makeState();
      const transitions: CompactionTransitionV2[] = [];
      subscribeSubagentObserver(session, state, {
        onCompactionTransition: (transition) => transitions.push(transition),
      });

      session.emit({ type: "compaction_start", reason: "threshold" });

      expect(transitions).toEqual([{ type: "start", started_at: "1970-01-01T00:00:01.000Z" }]);
      expect(state.compactionCount).toBe(0);
    });

    it("classifies a non-aborted result-less end as failed without affecting successful-compaction callbacks", () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      const session = createMockSession();
      const state = makeState();
      const transitions: CompactionTransitionV2[] = [];
      const onCompact = vi.fn();
      subscribeSubagentObserver(session, state, {
        onCompactionTransition: (transition) => transitions.push(transition),
        onCompact,
      });

      session.emit({ type: "compaction_start", reason: "threshold" });
      session.emit({ type: "compaction_end", aborted: false, reason: "threshold" });

      expect(transitions).toEqual([
        { type: "start", started_at: "1970-01-01T00:00:01.000Z" },
        { type: "failed" },
      ]);
      expect(state.compactionCount).toBe(0);
      expect(onCompact).not.toHaveBeenCalled();
    });
  });

  it("increments state.toolUses on tool_execution_end", () => {
    const session = createMockSession();
    const state = makeState();
    subscribeSubagentObserver(session, state);

    expect(state.toolUses).toBe(0);
    session.emit({ type: "tool_execution_end", toolName: "Read" });
    expect(state.toolUses).toBe(1);
    session.emit({ type: "tool_execution_end", toolName: "Write" });
    expect(state.toolUses).toBe(2);
  });

  it("accumulates lifetimeUsage on message_end with assistant usage", () => {
    const session = createMockSession();
    const state = makeState();
    subscribeSubagentObserver(session, state);

    session.emit({
      type: "message_end",
      message: { role: "assistant", usage: { input: 100, output: 50, cacheWrite: 10 } },
    });
    expect(state.lifetimeUsage).toEqual({ input: 100, output: 50, cacheWrite: 10 });

    session.emit({
      type: "message_end",
      message: { role: "assistant", usage: { input: 200, output: 80, cacheWrite: 20 } },
    });
    expect(state.lifetimeUsage).toEqual({ input: 300, output: 130, cacheWrite: 30 });
  });

  it("ignores message_end from non-assistant roles", () => {
    const session = createMockSession();
    const state = makeState();
    subscribeSubagentObserver(session, state);

    session.emit({
      type: "message_end",
      message: { role: "user", usage: { input: 999, output: 999, cacheWrite: 999 } },
    });
    expect(state.lifetimeUsage).toEqual({ input: 0, output: 0, cacheWrite: 0 });
  });

  it("increments compactionCount on compaction_end (not aborted)", () => {
    const session = createMockSession();
    const state = makeState();
    subscribeSubagentObserver(session, state);

    session.emit({
      type: "compaction_end",
      aborted: false,
      result: { tokensBefore: 12345 },
      reason: "threshold",
    });
    expect(state.compactionCount).toBe(1);

    session.emit({
      type: "compaction_end",
      aborted: false,
      result: { tokensBefore: 22222 },
      reason: "manual",
    });
    expect(state.compactionCount).toBe(2);
  });

  it("calls onCompact with info on compaction_end", () => {
    const session = createMockSession();
    const state = makeState();
    const onCompact = vi.fn();
    subscribeSubagentObserver(session, state, { onCompact });

    session.emit({
      type: "compaction_end",
      aborted: false,
      result: { tokensBefore: 12345 },
      reason: "threshold",
    });

    expect(onCompact).toHaveBeenCalledWith({
      reason: "threshold",
      tokensBefore: 12345,
    });
  });

  it("ignores compaction_end with aborted: true", () => {
    const session = createMockSession();
    const state = makeState();
    const onCompact = vi.fn();
    subscribeSubagentObserver(session, state, { onCompact });

    session.emit({
      type: "compaction_end",
      aborted: true,
      result: { tokensBefore: 5000 },
      reason: "overflow",
    });
    expect(state.compactionCount).toBe(0);
    expect(onCompact).not.toHaveBeenCalled();
  });

  it("ignores compaction_end without result", () => {
    const session = createMockSession();
    const state = makeState();
    subscribeSubagentObserver(session, state);

    session.emit({
      type: "compaction_end",
      aborted: false,
      reason: "threshold",
    });
    expect(state.compactionCount).toBe(0);
  });

  it("adds to activeTools on tool_execution_start", () => {
    const session = createMockSession();
    const state = makeState();
    subscribeSubagentObserver(session, state);

    session.emit({ type: "tool_execution_start", toolName: "Read" });
    expect(state.activeTools.size).toBe(1);
    expect([...state.activeTools.values()]).toContain("Read");
  });

  it("removes from activeTools on tool_execution_end (paired with start)", () => {
    const session = createMockSession();
    const state = makeState();
    subscribeSubagentObserver(session, state);

    session.emit({ type: "tool_execution_start", toolName: "Read" });
    session.emit({ type: "tool_execution_end", toolName: "Read" });
    expect(state.activeTools.size).toBe(0);
  });

  it("increments turnCount on turn_end", () => {
    const session = createMockSession();
    const state = makeState();
    subscribeSubagentObserver(session, state);

    expect(state.turnCount).toBe(1);
    session.emit({ type: "turn_end" });
    expect(state.turnCount).toBe(2);
    session.emit({ type: "turn_end" });
    expect(state.turnCount).toBe(3);
  });

  it("resets responseText on message_start", () => {
    const session = createMockSession();
    const state = makeState();
    subscribeSubagentObserver(session, state);

    session.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "previous text" },
    });
    session.emit({ type: "message_start" });
    expect(state.responseText).toBe("");
  });

  it("appends to responseText on message_update text_delta", () => {
    const session = createMockSession();
    const state = makeState();
    subscribeSubagentObserver(session, state);

    session.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Hello " },
    });
    expect(state.responseText).toBe("Hello ");

    session.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "world" },
    });
    expect(state.responseText).toBe("Hello world");
  });

  it("ignores message_update with non-text_delta events", () => {
    const session = createMockSession();
    const state = makeState();
    subscribeSubagentObserver(session, state);

    session.emit({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "pondering..." },
    });
    expect(state.responseText).toBe("");
  });

  it("returned function unsubscribes from session", () => {
    const session = createMockSession();
    const state = makeState();
    const unsubscribe = subscribeSubagentObserver(session, state);

    session.emit({ type: "tool_execution_end", toolName: "Read" });
    expect(state.toolUses).toBe(1);

    unsubscribe();

    session.emit({ type: "tool_execution_end", toolName: "Write" });
    expect(state.toolUses).toBe(1); // unchanged
  });
});
