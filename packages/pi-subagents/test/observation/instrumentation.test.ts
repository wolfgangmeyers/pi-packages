import { afterEach, describe, expect, it, vi } from "vitest";
import { createChildLifecyclePublisher } from "#src/lifecycle/child-lifecycle";
import { ConcurrencyLimiter } from "#src/lifecycle/concurrency-limiter";
import { SubagentManager } from "#src/lifecycle/subagent-manager";
import { CompositeSubagentObserver } from "#src/observation/composite-subagent-observer";
import {
  journalSubagentError,
  journalSubagentEvent,
  MECHA_JOURNAL_DATA_PROPERTY,
} from "#src/observation/instrumentation";
import type { NotificationSystem } from "#src/observation/notification";
import { SubagentEventsObserver } from "#src/observation/subagent-events-observer";
import { createTestSubagent, makeStubExecution } from "#test/helpers/make-subagent";
import { createSubagentSessionStub, toSubagentSession } from "#test/helpers/mock-session";
import { STUB_SNAPSHOT } from "#test/helpers/stub-ctx";

const journalProperty = MECHA_JOURNAL_DATA_PROPERTY;

type FakeJournal = {
  version: 1;
  record: ReturnType<
    typeof vi.fn<(source: "pi-subagents", event: string, fields?: Record<string, unknown>) => boolean>
  >;
};

function installJournal(): FakeJournal {
  const journal: FakeJournal = {
    version: 1,
    record: vi.fn<(source: "pi-subagents", event: string, fields?: Record<string, unknown>) => boolean>(),
  };
  Object.defineProperty(globalThis, journalProperty, { value: journal, configurable: true });
  return journal;
}

function makeNotifications(): NotificationSystem {
  return { sendCompletion: vi.fn(), dispose: vi.fn() };
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, journalProperty);
});

describe("pi-subagents instrumentation", () => {
  it("submits fixed body-free fields through the versioned global journal", () => {
    const journal = installJournal();

    journalSubagentEvent("subagents:running", {
      agent_id: "agent-1",
      kind: "general-purpose",
      status: "running",
      state: "running",
    });

    expect(journal.record).toHaveBeenCalledExactlyOnceWith("pi-subagents", "subagents.running", {
      agent_id: "agent-1",
      kind: "general-purpose",
      status: "running",
      state: "running",
    });
    expect(journal.record.mock.calls[0]?.[2]).not.toHaveProperty("body");
    expect(journal.record.mock.calls[0]?.[2]).not.toHaveProperty("result");
  });

  it("rejects diagnostic strings that could carry prompt or error content", () => {
    const journal = installJournal();

    journalSubagentEvent("subagents:running", {
      agent_id: "agent-1",
      kind: "private prompt text",
      status: "running",
      phase: "private phase text",
      error_code: "private error code text",
    });

    expect(journal.record).toHaveBeenCalledExactlyOnceWith("pi-subagents", "subagents.running", {
      agent_id: "agent-1",
      status: "running",
    });
    expect(JSON.stringify(journal.record.mock.calls[0]?.[2])).not.toContain("private");
  });

  it("drops oversized error codes without truncating private text", () => {
    const journal = installJournal();
    const error = Object.assign(new Error("private error body"), { code: "x".repeat(65) });

    journalSubagentError("manual", error, { agent_id: "agent-1" });

    expect(journal.record).toHaveBeenCalledExactlyOnceWith("pi-subagents", "subagents.error", {
      agent_id: "agent-1",
      error_name: "Error",
      phase: "manual",
    });
    expect(JSON.stringify(journal.record.mock.calls[0]?.[2])).not.toContain("x".repeat(65));
  });

  it("ignores unknown journal event names", () => {
    const journal = installJournal();

    journalSubagentEvent("subagents:private-prompt", { agent_id: "agent-1" });

    expect(journal.record).not.toHaveBeenCalled();
  });

  it("makes caught lifecycle errors visible without including error text", () => {
    const journal = installJournal();
    const observer = new CompositeSubagentObserver([{
      onSubagentStarted: () => { throw new Error("prompt body must stay private"); },
      onSubagentCompleted: () => {},
      onSubagentResumed: () => {},
      onSubagentCompacted: () => {},
      onSubagentCreated: () => {},
    }]);

    observer.onSubagentStarted(createTestSubagent({ id: "agent-2" }));

    expect(journal.record).toHaveBeenCalledExactlyOnceWith("pi-subagents", "subagents.error", {
      error_name: "Error",
      phase: "observer.onSubagentStarted",
    });
    expect(JSON.stringify(journal.record.mock.calls[0]?.[2])).not.toContain("prompt body");
    journalSubagentError("manual", new TypeError("secret body"), { agent_id: "agent-2" });
    expect(journal.record).toHaveBeenLastCalledWith("pi-subagents", "subagents.error", {
      agent_id: "agent-2",
      error_name: "TypeError",
      phase: "manual",
    });
  });

  it("shares one process-global journal between root and child lifecycle publishers", () => {
    const journal = installJournal();
    const emit = vi.fn<(channel: string, data: unknown) => void>();
    const publisher = createChildLifecyclePublisher(emit);

    publisher.spawning({ agentName: "general-purpose", parentSessionId: "root" });
    publisher.sessionCreated({ sessionId: "child", parentSessionId: "root" });
    publisher.completed({ sessionDir: "/private/path", agentName: "general-purpose", aborted: false, steered: false });
    publisher.disposed({ sessionId: "child" });

    expect(journal.record.mock.calls.map(([, event]) => event)).toEqual([
      "subagents.child.spawning",
      "subagents.child.session_created",
      "subagents.child.completed",
      "subagents.child.disposed",
    ]);
    expect(journal.record.mock.calls.flatMap(([, , fields]) => Object.values(fields ?? {}))).not.toContain("/private/path");
    expect(emit).toHaveBeenCalledTimes(4);
  });

  it("journals a publisher failure before rethrowing the event-bus error", () => {
    const journal = installJournal();
    const publisher = createChildLifecyclePublisher(() => {
      throw new Error("event delivery failed");
    });

    expect(() => publisher.sessionCreated({ sessionId: "child", parentSessionId: "root" })).toThrow("event delivery failed");
    expect(journal.record).toHaveBeenLastCalledWith("pi-subagents", "subagents.error", {
      error_name: "Error",
      phase: "child_lifecycle_emit",
      session_id: "child",
      parent_session_id: "root",
    });
    expect(JSON.stringify(journal.record.mock.calls.at(-1)?.[2])).not.toContain("event delivery failed");
  });

  it("joins a manager agent ID to its child session ID", async () => {
    const journal = installJournal();
    const session = createSubagentSessionStub();
    const agent = createTestSubagent({
      id: "manager-agent",
      execution: makeStubExecution({
        parentSession: { parentSessionId: "root-session" },
        createSubagentSession: async () => toSubagentSession(session),
      }),
    });

    await agent.run();

    expect(journal.record).toHaveBeenCalledWith("pi-subagents", "subagents.child.session_linked", {
      agent_id: "manager-agent",
      session_id: "child-session-id",
      parent_session_id: "root-session",
    });
  });

  it("journals an onSessionCreated failure and closes the child through the terminal path", async () => {
    const journal = installJournal();
    const session = createSubagentSessionStub();
    const completed = vi.fn();
    const manager = new SubagentManager({
      createSubagentSession: async () => toSubagentSession(session),
      limiter: new ConcurrencyLimiter(() => 1),
      baseCwd: "/repo",
      observer: {
        onSubagentStarted: vi.fn(),
        onSubagentCompleted: completed,
        onSubagentResumed: vi.fn(),
        onSubagentCompacted: vi.fn(),
        onSubagentCreated: vi.fn(),
      },
    });

    try {
      const id = manager.spawn(STUB_SNAPSHOT, "Plan", "prompt", {
        description: "test",
        observer: {
          onSessionCreated: () => { throw new TypeError("private callback text"); },
        },
      });
      const record = manager.getRecord(id);
      expect(record).toBeDefined();

      await record?.promise;
      expect(record?.status).toBe("error");
      expect(manager.hasRunning()).toBe(false);
      expect(record?.isSessionReady()).toBe(false);
      expect(completed).toHaveBeenCalledOnce();
      expect(session.dispose).toHaveBeenCalledOnce();
      const errorEntry = journal.record.mock.calls.findLast(([, event]) => event === "subagents.error");
      expect(errorEntry).toEqual(["pi-subagents", "subagents.error", {
        agent_id: id,
        session_id: "child-session-id",
        error_name: "TypeError",
        phase: "on_session_created",
      }]);
      expect(JSON.stringify(errorEntry?.[2])).not.toContain("private callback text");
    } finally {
      manager.dispose();
    }
  });

  it("journals snapshot cap, eviction, and redaction with counts and IDs only", () => {
    const journal = installJournal();
    const manager = new SubagentManager({
      createSubagentSession: () => new Promise(() => {}),
      limiter: new ConcurrencyLimiter(() => 101),
      baseCwd: "/repo",
    });
    const ids: string[] = [];

    try {
      for (let index = 0; index <= 100; index++) {
        ids.push(manager.spawn(STUB_SNAPSHOT, "Plan", `private prompt ${index}`, {
          description: `private description ${index}`,
        }));
      }

      expect(journal.record).toHaveBeenCalledWith("pi-subagents", "subagents.snapshot_capped", {
        snapshot_count: 100,
        subagent_count: 101,
      });
      expect(journal.record).toHaveBeenCalledWith("pi-subagents", "subagents.snapshot_evicted", {
        agent_id: ids[0],
        snapshot_count: 99,
      });
      const normalized = journal.record.mock.calls
        .filter(([, event]) => event === "subagents.snapshot_normalized")
        .at(-1);
      expect(normalized).toEqual(["pi-subagents", "subagents.snapshot_normalized", {
        agent_id: ids.at(-1),
        snapshot_count: 100,
      }]);
      for (const [, event, fields] of journal.record.mock.calls) {
        if (!event.startsWith("subagents.snapshot")) continue;
        expect(Object.keys(fields ?? {}).every((key) => ["agent_id", "snapshot_count", "subagent_count"].includes(key))).toBe(true);
      }
    } finally {
      manager.dispose();
    }
  });

  it("journals public root lifecycle events", () => {
    const journal = installJournal();
    const observer = new SubagentEventsObserver({
      emit: vi.fn(),
      appendEntry: vi.fn(),
      notifications: makeNotifications(),
    });
    const record = createTestSubagent({ id: "agent-3", type: "Plan", status: "completed" });

    observer.onSubagentCreated(record);
    observer.onSubagentStarted(record);
    observer.onSubagentCompleted(record);
    observer.onSubagentResumed(record);
    observer.onSubagentCompacted(record, { reason: "manual", tokensBefore: 42 });

    expect(journal.record.mock.calls.map(([, event]) => event)).toEqual([
      "subagents.created",
      "subagents.running",
      "subagents.terminal",
      "subagents.resume_terminal",
      "subagents.compacted",
    ]);
  });

  it("is a no-op when Mecha has not published the version-one interface", () => {
    const emit = vi.fn<(channel: string, data: unknown) => void>();
    journalSubagentEvent("subagents:running", { agent_id: "agent-4" });
    expect(emit).not.toHaveBeenCalled();
  });
});
