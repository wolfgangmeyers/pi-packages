import { type AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConcurrencyLimiter } from "#src/lifecycle/concurrency-limiter";
import type { CreateSubagentSessionParams } from "#src/lifecycle/create-subagent-session";
import {
  MAX_SNAPSHOT_NODES,
  MAX_SNAPSHOT_UTF8_BYTES,
  MAX_SOURCE_CHILDREN_PER_SNAPSHOT,
  MAX_V2_STRING_UTF8_BYTES,
  SubagentManager,
  type SubagentManagerObserver,
} from "#src/lifecycle/subagent-manager";
import { SubagentSession } from "#src/lifecycle/subagent-session";
import type { WorkspaceProvider } from "#src/lifecycle/workspace";
import { NotificationManager } from "#src/observation/notification";
import type { RunConfig } from "#src/runtime";
import type { SubagentLifecycleSnapshot } from "#src/service/service";
import type {
  ContextRefV1,
  ControlResultPayloadV1,
  LifecycleSnapshotV2ServiceRow,
  SourceChildV2,
  Subagent,
  SubagentLifecycleDeltaV2,
} from "#src/types";
import { makeModel } from "#test/helpers/make-model";
import { createBlockingFactory, createSessionFactory } from "#test/helpers/manager-stubs";
import { createMockSession, createSubagentSessionStub, emitResumeUsageAndCompaction, toSubagentSession } from "#test/helpers/mock-session";
import { STUB_SNAPSHOT } from "#test/helpers/stub-ctx";
import { createChildLifecycleMock } from "#test/helpers/subagent-session-io";

/** Default max concurrent background agents (matches production default). */
const DEFAULT_MAX_CONCURRENT = 4;

type SessionFactory = (params: CreateSubagentSessionParams) => Promise<SubagentSession>;

/** Default factory: resolves to a fresh SubagentSession stub on every spawn. */
function defaultFactory(): SessionFactory {
  return vi.fn(async (_params: CreateSubagentSessionParams) => toSubagentSession(createSubagentSessionStub()));
}

/** Test helper: construct an SubagentManager with injected stubs. */
function createManager(overrides?: {
  createSubagentSession?: SessionFactory;
  observer?: Partial<SubagentManagerObserver>;
  getMaxConcurrent?: () => number;
  getRunConfig?: () => RunConfig;
  getRetentionPolicy?: () => { consumedSessionRetentionMinutes: number; unconsumedSessionRetentionMinutes: number };
  baseCwd?: string;
}) {
  const createSubagentSession: SessionFactory = overrides?.createSubagentSession ?? defaultFactory();
  const observer: SubagentManagerObserver | undefined = overrides?.observer
    ? {
        onSubagentStarted: overrides.observer.onSubagentStarted ?? (() => {}),
        onSubagentCompleted: overrides.observer.onSubagentCompleted ?? (() => {}),
        onSubagentResumed: overrides.observer.onSubagentResumed ?? (() => {}),
        onSubagentCompacted: overrides.observer.onSubagentCompacted ?? (() => {}),
        onSubagentCreated: overrides.observer.onSubagentCreated ?? (() => {}),
      }
    : undefined;
  const limiter = new ConcurrencyLimiter(overrides?.getMaxConcurrent ?? (() => DEFAULT_MAX_CONCURRENT));
  const mgr = new SubagentManager({
    createSubagentSession,
    observer,
    limiter,
    baseCwd: overrides?.baseCwd ?? "/repo",
    getRunConfig: overrides?.getRunConfig,
    getRetentionPolicy: overrides?.getRetentionPolicy,
  });
  return { manager: mgr, createSubagentSession, limiter };
}

/** Spawn a background agent using STUB_SNAPSHOT. */
function spawnBg(mgr: SubagentManager, prompt = "test", desc = prompt) {
  return mgr.spawn(STUB_SNAPSHOT, "general-purpose", prompt, {
    description: desc,
  });
}

/** Spawn a background agent carrying a parentSession.toolCallId (notification path). */
function spawnBgWithToolCall(mgr: SubagentManager, toolCallId: string, prompt = "test", desc = prompt) {
  return mgr.spawn(STUB_SNAPSHOT, "general-purpose", prompt, {
    description: desc,
    parentSession: { toolCallId },
  });
}

/** Arrange a manager at limit 1 with two bg agents over a blocking factory: first runs, second queues. */
function arrangeQueuedPair(observer?: Partial<SubagentManagerObserver>) {
  const factory = createBlockingFactory();
  const { manager: mgr } = createManager({ createSubagentSession: factory, getMaxConcurrent: () => 1, observer });
  const running = spawnBg(mgr, "a");
  const queued = spawnBg(mgr, "b");
  return { manager: mgr, factory, running, queued };
}

/**
 * Arrange a manager whose onSubagentCompleted observer forwards to a real
 * NotificationManager (mirroring SubagentEventsObserver's unconditional
 * sendCompletion delegation), with one background agent spawned via a tool
 * call. The act (when the record is marked consumed relative to awaiting)
 * stays in each test.
 */
function seedNotificationScenario() {
  const sendMessage = vi.fn();
  const notifications = new NotificationManager(sendMessage);
  const { manager } = createManager({
    observer: { onSubagentCompleted: (r) => notifications.sendCompletion(r) },
  });
  // The spawning tool call runs inside a parent agent run, so nudges are
  // withheld until it settles.
  notifications.onParentAgentStart();
  const id = spawnBgWithToolCall(manager, "tc-1");
  const record = manager.getRecord(id)!;
  return { manager, record, notifications, sendMessage };
}

describe("SubagentManager — Bug 1 race condition (consumed state vs onComplete)", () => {
  let manager: SubagentManager;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    manager.dispose();
    vi.useRealTimers();
  });

  it("marking consumed after awaiting still suppresses the nudge (flush-time re-check)", async () => {
    const seeded = seedNotificationScenario();
    manager = seeded.manager;
    const { record, sendMessage } = seeded;

    // onSubagentCompleted already withheld the nudge by the time this await
    // resumes (it fires synchronously inside record.promise's resolution
    // chain). The parent pulls the result (markConsumed) later in the same
    // run; the notification manager re-reads record.consumed when the run
    // settles and drops the nudge — no separate cancel call needed.
    await record.promise;
    record.markConsumed();

    seeded.notifications.onParentAgentSettled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("marking consumed before await suppresses the nudge (schedule-time guard)", async () => {
    const seeded = seedNotificationScenario();
    manager = seeded.manager;
    const { record, sendMessage } = seeded;

    // The parent already holds the result: sendCompletion sees record.consumed
    // at enqueue time and never withholds a nudge to flush.
    record.markConsumed();
    await record.promise;

    seeded.notifications.onParentAgentSettled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

});

describe("SubagentManager — completion callbacks", () => {
  let manager: SubagentManager;

  afterEach(() => {
    manager.dispose();
  });

  it("does not let onComplete errors turn a completed agent into a failed run", async () => {
    ({ manager } = createManager({ observer: { onSubagentCompleted: () => {
      throw new Error("stale extension context");
    } } }));

    const id = spawnBg(manager);
    await expect(manager.getRecord(id)!.promise).resolves.toBeUndefined();

    expect(manager.getRecord(id)!.status).toBe("completed");
  });
});

describe("SubagentManager — cleanup timer", () => {
  let manager: SubagentManager;

  afterEach(() => {
    manager.dispose();
  });

  it("does not keep the process alive on its own", () => {
    ({ manager } = createManager());

    expect((manager as any).sweepInterval.hasRef()).toBe(false);
  });
});

describe("SubagentManager — Bug 3 clearCompleted", () => {
  let manager: SubagentManager;

  afterEach(() => {
    manager.dispose();
  });

  it("clearCompleted removes completed records", async () => {
    ({ manager } = createManager());

    const id = spawnBg(manager);
    await manager.getRecord(id)!.promise;

    expect(manager.listAgents()).toHaveLength(1);
    manager.clearCompleted();
    expect(manager.listAgents()).toHaveLength(0);
  });

  it("clearCompleted does not remove running or queued agents", async () => {
    // Use maxConcurrent=1 to keep second agent queued; factory never resolves
    ({ manager } = createManager({ getMaxConcurrent: () => 1, createSubagentSession: createBlockingFactory() }));

    const id1 = spawnBg(manager, "test1", "running agent");
    // Second agent should be queued (limit=1)
    const id2 = spawnBg(manager, "test2", "queued agent");

    expect(manager.getRecord(id1)!.status).toBe("running");
    expect(manager.getRecord(id2)!.status).toBe("queued");

    manager.clearCompleted();

    // Both should still be present
    expect(manager.getRecord(id1)).toBeDefined();
    expect(manager.getRecord(id2)).toBeDefined();

    // Abort to allow cleanup
    manager.abort(id1);
    manager.abort(id2);
  });

  it("clearCompleted calls dispose on sessions of removed records", async () => {
    const disposeSpy = vi.fn();
    const sess = createMockSession({ dispose: disposeSpy });
    const { factory } = createSessionFactory(sess);
    ({ manager } = createManager({ createSubagentSession: factory }));

    const id = spawnBg(manager);
    await manager.getRecord(id)!.promise;

    manager.clearCompleted();

    expect(disposeSpy).toHaveBeenCalledOnce();
  });

  it("clearCompleted removes error and stopped records", async () => {
    const { factory, stub } = createSessionFactory();
    stub.runTurnLoop.mockRejectedValue(new Error("boom"));
    ({ manager } = createManager({ createSubagentSession: factory }));

    const id = spawnBg(manager);
    await manager.getRecord(id)!.promise;
    expect(manager.getRecord(id)!.status).toBe("error");

    manager.clearCompleted();
    expect(manager.getRecord(id)).toBeUndefined();
  });
});

describe("SubagentManager — consumption-aware session release sweep", () => {
  let manager: SubagentManager;

  afterEach(() => {
    vi.restoreAllMocks();
    manager.dispose();
  });

  /** Spawn a background agent over a session factory and await its completion. */
  async function spawnCompleted(
    outputFile: string | undefined = "/tasks/agent.jsonl",
    getRetentionPolicy?: () => { consumedSessionRetentionMinutes: number; unconsumedSessionRetentionMinutes: number },
  ): Promise<string> {
    const { factory } = createSessionFactory(createMockSession(), outputFile);
    ({ manager } = createManager({ createSubagentSession: factory, getRetentionPolicy }));
    const id = spawnBg(manager, "test", "investigate the bug");
    await manager.getRecord(id)!.promise;
    return id;
  }

  it("releases a consumed agent's session 10 min after consumption but keeps the record", async () => {
    const id = await spawnCompleted("/tasks/agent.jsonl");
    const record = manager.getRecord(id)!;
    const completedAt = record.completedAt!;
    record.markConsumed(completedAt + 5 * 60_000); // consumed 5 min after completion
    const nowSpy = vi.spyOn(Date, "now");

    // 10 min after completion is only 5 min after consumption → still retained.
    nowSpy.mockReturnValue(completedAt + 10 * 60_000);
    (manager as any).sweep();
    expect(manager.getRecord(id)!.isSessionReady()).toBe(true);

    // 10 min after consumption → session released, record survives.
    nowSpy.mockReturnValue(completedAt + 15 * 60_000);
    (manager as any).sweep();
    const swept = manager.getRecord(id)!;
    expect(swept).toBeDefined();
    expect(swept.isSessionReady()).toBe(false);
    expect(swept.outputFile).toBe("/tasks/agent.jsonl");
  });

  it("holds an unconsumed agent's session past 10 min and releases it at the cap", async () => {
    const id = await spawnCompleted("/tasks/agent.jsonl");
    const completedAt = manager.getRecord(id)!.completedAt!;
    const nowSpy = vi.spyOn(Date, "now");

    nowSpy.mockReturnValue(completedAt + 11 * 60_000); // past the consumed window
    (manager as any).sweep();
    expect(manager.getRecord(id)!.isSessionReady()).toBe(true); // unconsumed → held

    nowSpy.mockReturnValue(completedAt + 721 * 60_000); // past the 12h cap
    (manager as any).sweep();
    expect(manager.getRecord(id)!.isSessionReady()).toBe(false);
  });

  it("never releases a running or queued agent's session", async () => {
    ({ manager } = createManager({ getMaxConcurrent: () => 1, createSubagentSession: createBlockingFactory() }));
    const runningId = spawnBg(manager, "t1");
    const queuedId = spawnBg(manager, "t2");
    expect(manager.getRecord(runningId)!.status).toBe("running");
    expect(manager.getRecord(queuedId)!.status).toBe("queued");
    const runRelease = vi.spyOn(manager.getRecord(runningId)!, "releaseSession");
    const queueRelease = vi.spyOn(manager.getRecord(queuedId)!, "releaseSession");

    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10_000 * 60_000);
    (manager as any).sweep();

    expect(runRelease).not.toHaveBeenCalled();
    expect(queueRelease).not.toHaveBeenCalled();
    manager.abort(runningId);
    manager.abort(queuedId);
  });

  it("honors a custom retention policy from getRetentionPolicy", async () => {
    const id = await spawnCompleted("/t.jsonl", () => ({
      consumedSessionRetentionMinutes: 1,
      unconsumedSessionRetentionMinutes: 2,
    }));
    const record = manager.getRecord(id)!;
    const completedAt = record.completedAt!;
    record.markConsumed(completedAt);
    vi.spyOn(Date, "now").mockReturnValue(completedAt + 2 * 60_000); // 2 min > 1 min window
    (manager as any).sweep();
    expect(manager.getRecord(id)!.isSessionReady()).toBe(false);
  });

  it("leaves records in place after release (getRecord still resolves them)", async () => {
    const id = await spawnCompleted("/tasks/agent.jsonl");
    const completedAt = manager.getRecord(id)!.completedAt!;
    vi.spyOn(Date, "now").mockReturnValue(completedAt + 721 * 60_000);
    (manager as any).sweep();
    expect(manager.listAgents()).toHaveLength(1);
    expect(manager.getRecord(id)).toBeDefined();
  });
});

// Eager init removes the optional/required asymmetry that previously required
// `??=` defaults at the callback sites and `?? 0` / `?? 1` at the read sites.
describe("SubagentManager — lifetime usage + compaction count are eagerly initialized", () => {
  let manager: SubagentManager;

  afterEach(() => {
    manager.dispose();
  });

  it("spawn initializes lifetimeUsage to zeros and compactionCount to 0", () => {
    // Factory never resolves — we just want to inspect the record at spawn time.
    ({ manager } = createManager({ createSubagentSession: createBlockingFactory() }));

    const id = spawnBg(manager);
    const record = manager.getRecord(id)!;

    expect(record.lifetimeUsage).toEqual({ input: 0, output: 0, cacheWrite: 0 });
    expect(record.compactionCount).toBe(0);

    manager.abort(id);
  });

  it("record observer accumulates assistant usage into record.lifetimeUsage", async () => {
    // The record observer subscribes to session events via the wired subagentSession.
    // Emitting message_end events from runTurnLoop drives stats.
    const session = createMockSession();
    const { factory, stub } = createSessionFactory(session);
    stub.runTurnLoop.mockImplementation(async () => {
      session.emit({ type: "message_end", message: { role: "assistant", usage: { input: 100, output: 50, cacheWrite: 10 } } });
      session.emit({ type: "message_end", message: { role: "assistant", usage: { input: 200, output: 80, cacheWrite: 20 } } });
      return { responseText: "done", aborted: false, steered: false };
    });
    ({ manager } = createManager({ createSubagentSession: factory }));

    const id = spawnBg(manager);
    await manager.getRecord(id)!.promise;

    expect(manager.getRecord(id)!.lifetimeUsage).toEqual({
      input: 300, output: 130, cacheWrite: 30,
    });
  });

  it("record observer increments compactionCount on compaction_end events", async () => {
    const compactSeen: any[] = [];

    const session = createMockSession();
    const { factory, stub } = createSessionFactory(session);
    stub.runTurnLoop.mockImplementation(async () => {
      // Compaction fires while the agent is still running — the record passed to
      // onCompact should reflect the just-incremented count.
      session.emit({ type: "compaction_end", aborted: false, result: { tokensBefore: 12345 }, reason: "threshold" });
      session.emit({ type: "compaction_end", aborted: false, result: { tokensBefore: 22222 }, reason: "manual" });
      return { responseText: "done", aborted: false, steered: false };
    });

    ({ manager } = createManager({ createSubagentSession: factory, observer: { onSubagentCompacted: (record, info) => {
      compactSeen.push({ count: record.compactionCount, reason: info.reason });
    } } }));

    const id = spawnBg(manager);
    await manager.getRecord(id)!.promise;

    expect(compactSeen).toEqual([
      { count: 1, reason: "threshold" },
      { count: 2, reason: "manual" },
    ]);
    expect(manager.getRecord(id)!.compactionCount).toBe(2);
  });

  it("resume() also accumulates usage and increments compactions on the same record", async () => {
    // Spawn with a subscribable session that resume can latch onto.
    const session = createMockSession();
    const { factory, stub } = createSessionFactory(session);
    stub.resumeTurnLoop.mockImplementation(async () => {
      // Emit events through the session — the record observer subscribed by
      // SubagentManager.resume() will pick them up.
      emitResumeUsageAndCompaction(session);
      return "second";
    });
    ({ manager } = createManager({ createSubagentSession: factory }));

    const id = spawnBg(manager);
    await manager.getRecord(id)!.promise;

    // Pre-resume: lifetimeUsage from spawn was zero (run did not emit usage events)
    expect(manager.getRecord(id)!.lifetimeUsage).toEqual({ input: 0, output: 0, cacheWrite: 0 });
    expect(manager.getRecord(id)!.compactionCount).toBe(0);

    await manager.resume(id, "more");

    expect(manager.getRecord(id)!.lifetimeUsage).toEqual({ input: 70, output: 30, cacheWrite: 5 });
    expect(manager.getRecord(id)!.compactionCount).toBe(1);
  });
});

describe("SubagentManager — getRunConfig threads defaultMaxTurns and graceTurns into the turn loop", () => {
  let manager: SubagentManager;

  afterEach(() => {
    manager.dispose();
  });

  it("passes defaultMaxTurns and graceTurns from getRunConfig to runTurnLoop", async () => {
    const getRunConfig = vi.fn(() => ({ defaultMaxTurns: 10, graceTurns: 3 }));
    const { factory, stub } = createSessionFactory();
    ({ manager } = createManager({ getRunConfig, createSubagentSession: factory }));

    const id = spawnBg(manager);
    await manager.getRecord(id)!.promise;

    const turnOpts = stub.runTurnLoop.mock.calls[0][1];
    expect(turnOpts.defaultMaxTurns).toBe(10);
    expect(turnOpts.graceTurns).toBe(3);
  });

  it("omits defaultMaxTurns and graceTurns from runTurnLoop when no getRunConfig is provided", async () => {
    const { factory, stub } = createSessionFactory();
    ({ manager } = createManager({ createSubagentSession: factory }));

    const id = spawnBg(manager);
    await manager.getRecord(id)!.promise;

    const turnOpts = stub.runTurnLoop.mock.calls[0][1];
    expect(turnOpts.defaultMaxTurns).toBeUndefined();
    expect(turnOpts.graceTurns).toBeUndefined();
  });
});

describe("SubagentManager — parent session threading", () => {
  let manager: SubagentManager;

  afterEach(() => {
    manager.dispose();
  });

  it("threads parentSession from AgentSpawnConfig to the factory params", async () => {
    const { factory } = createSessionFactory();
    ({ manager } = createManager({ createSubagentSession: factory }));

    manager.spawn(STUB_SNAPSHOT, "general-purpose", "test", {
      description: "test",
      parentSession: { parentSessionFile: "/sessions/parent.jsonl", parentSessionId: "parent-session-123" },
    });

    await vi.waitFor(() => expect(factory).toHaveBeenCalled());

    const params = vi.mocked(factory).mock.calls[0][0];
    expect(params.parentSession?.parentSessionFile).toBe("/sessions/parent.jsonl");
    expect(params.parentSession?.parentSessionId).toBe("parent-session-123");
  });
});

describe("SubagentManager — dependency injection via options bag", () => {
  let manager: SubagentManager;

  afterEach(() => {
    manager.dispose();
  });

  it("calls the injected factory when spawning an agent", async () => {
    const { factory } = createSessionFactory();
    ({ manager } = createManager({ createSubagentSession: factory }));

    const id = spawnBg(manager);
    await manager.getRecord(id)!.promise;

    expect(factory).toHaveBeenCalledOnce();
    expect(manager.getRecord(id)!.result).toBe("done");
  });

  it("calls resumeTurnLoop on the SubagentSession when resuming an agent", async () => {
    const { factory, stub } = createSessionFactory();
    stub.resumeTurnLoop.mockResolvedValue("second");
    ({ manager } = createManager({ createSubagentSession: factory }));

    const id = spawnBg(manager);
    await manager.getRecord(id)!.promise;

    await manager.resume(id, "continue");

    expect(stub.resumeTurnLoop).toHaveBeenCalledOnce();
    expect(manager.getRecord(id)!.result).toBe("second");
  });

  it("manager.abort cancels a running child's turn signal", async () => {
    const { factory, stub } = createSessionFactory();
    let childSignal: AbortSignal | undefined;
    stub.runTurnLoop.mockImplementation(
      (_prompt: string, options: { signal?: AbortSignal }) =>
        new Promise((resolve, reject) => {
          if (!options.signal) {
            reject(new Error("missing child abort signal"));
            return;
          }
          childSignal = options.signal;
          options.signal.addEventListener(
            "abort",
            () => resolve({ responseText: "", aborted: true, steered: false }),
            { once: true },
          );
        }),
    );
    ({ manager } = createManager({ createSubagentSession: factory }));

    const id = spawnBg(manager);
    await vi.waitFor(() => expect(stub.runTurnLoop).toHaveBeenCalledOnce());

    expect(manager.abort(id)).toBe(true);
    await manager.getRecord(id)!.promise;

    expect(childSignal?.aborted).toBe(true);
    expect(manager.getRecord(id)!.status).toBe("stopped");
  });

  it("fires onSubagentResumed when an agent is resumed", async () => {
    const onSubagentResumed = vi.fn();
    const { factory, stub } = createSessionFactory();
    stub.resumeTurnLoop.mockResolvedValue("second");
    ({ manager } = createManager({ createSubagentSession: factory, observer: { onSubagentResumed } }));

    const id = spawnBg(manager);
    await manager.getRecord(id)!.promise;
    await manager.resume(id, "continue");

    expect(onSubagentResumed).toHaveBeenCalledExactlyOnceWith(manager.getRecord(id));
  });
});

describe("SubagentManager — queueing and concurrency with injected stubs", () => {
  let manager: SubagentManager;

  afterEach(() => {
    manager.dispose();
  });

  it("queues excess background agents and drains them in order", async () => {
    const startOrder: string[] = [];
    const { promise: gate1, resolve: resolve1 } = Promise.withResolvers<void>(); // eslint-disable-line @typescript-eslint/no-invalid-void-type -- Promise.withResolvers<void> is valid; rule does not allow void in generic fn call type args
    const { promise: gate2, resolve: resolve2 } = Promise.withResolvers<void>(); // eslint-disable-line @typescript-eslint/no-invalid-void-type -- Promise.withResolvers<void> is valid; rule does not allow void in generic fn call type args

    let callCount = 0;
    const factory: SessionFactory = vi.fn(async () => {
      callCount++;
      const n = callCount;
      startOrder.push(`start-${n}`);
      const stub = createSubagentSessionStub();
      stub.runTurnLoop.mockImplementation(async () => {
        if (n === 1) await gate1;
        if (n === 2) await gate2;
        return { responseText: `result-${n}`, aborted: false, steered: false };
      });
      return toSubagentSession(stub);
    });
    ({ manager } = createManager({ createSubagentSession: factory, getMaxConcurrent: () => 1 }));

    // Spawn two background agents — first runs, second queues
    const id1 = spawnBg(manager, "test1", "first");
    const id2 = spawnBg(manager, "test2", "second");

    expect(manager.getRecord(id1)!.status).toBe("running");
    expect(manager.getRecord(id2)!.status).toBe("queued");

    // Complete first agent — second should start
    resolve1();
    await manager.getRecord(id1)!.promise;

    // Wait for the second to start
    await vi.waitFor(() => expect(manager.getRecord(id2)!.status).toBe("running"));

    resolve2();
    await manager.getRecord(id2)!.promise;

    expect(startOrder).toEqual(["start-1", "start-2"]);
    expect(manager.getRecord(id1)!.result).toBe("result-1");
    expect(manager.getRecord(id2)!.result).toBe("result-2");
  });

  it("gives a queued agent an awaitable promise at spawn (before its slot opens)", () => {
    const { manager: mgr, running, queued } = arrangeQueuedPair();
    manager = mgr;

    // A still-queued agent must already expose a settle-on-completion promise.
    // Regression guard: #374 made the promise lazy; the limiter handle is captured eagerly.
    expect(manager.getRecord(queued)!.status).toBe("queued");
    expect(manager.getRecord(queued)!.promise).toBeInstanceOf(Promise);

    manager.abort(running);
    manager.abort(queued);
  });

  it("abort removes a queued agent without ever running it", () => {
    const { manager: mgr, factory, running, queued } = arrangeQueuedPair();
    manager = mgr;

    expect(manager.getRecord(queued)!.status).toBe("queued");

    // Abort the queued agent
    expect(manager.abort(queued)).toBe(true);
    expect(manager.getRecord(queued)!.status).toBe("stopped");

    // factory was called once (for the first agent), never for the aborted one
    expect(factory).toHaveBeenCalledOnce();

    manager.abort(running);
  });

  it("onStart fires when agent transitions from queued to running", async () => {
    const startedIds: string[] = [];
    const { promise: gate, resolve } = Promise.withResolvers<void>(); // eslint-disable-line @typescript-eslint/no-invalid-void-type -- Promise.withResolvers<void> is valid; rule does not allow void in generic fn call type args

    let callCount = 0;
    const factory: SessionFactory = vi.fn(async () => {
      callCount++;
      const n = callCount;
      const stub = createSubagentSessionStub();
      stub.runTurnLoop.mockImplementation(async () => {
        if (n === 1) await gate;
        return { responseText: "ok", aborted: false, steered: false };
      });
      return toSubagentSession(stub);
    });
    ({ manager } = createManager({
      createSubagentSession: factory,
      getMaxConcurrent: () => 1,
      observer: { onSubagentStarted: (record) => { startedIds.push(record.id); } },
    }));

    const id1 = spawnBg(manager, "a");
    const id2 = spawnBg(manager, "b");

    // First agent started immediately
    expect(startedIds).toEqual([id1]);

    // Complete first — second should start and fire onStart
    resolve();
    await manager.getRecord(id1)!.promise;
    await vi.waitFor(() => expect(startedIds).toHaveLength(2));

    expect(startedIds).toEqual([id1, id2]);

    await manager.getRecord(id2)!.promise;
  });
});

// Diagnosis, boundary, and these three cases contributed by @daoguademeng in #665.
describe("SubagentManager — stopping a queued agent", () => {
  let manager: SubagentManager;

  afterEach(() => {
    manager.dispose();
  });

  it("abort() on a queued agent notifies onSubagentCompleted", () => {
    const completed: Subagent[] = [];
    const { manager: mgr, running, queued } = arrangeQueuedPair({
      onSubagentCompleted: (record) => completed.push(record),
    });
    manager = mgr;

    expect(manager.abort(queued)).toBe(true);

    expect(completed).toHaveLength(1);
    expect(completed[0]).toBe(manager.getRecord(queued));
    expect(manager.getRecord(queued)!.status).toBe("stopped");
    expect(manager.getRecord(queued)!.stoppedWhileQueued).toBe(true);

    manager.abort(running);
  });

  it("abortAll() notifies onSubagentCompleted for queued agents", () => {
    const completed: Subagent[] = [];
    const { manager: mgr, queued } = arrangeQueuedPair({
      onSubagentCompleted: (record) => completed.push(record),
    });
    manager = mgr;

    expect(manager.abortAll()).toBe(2);

    // Only the queued agent notifies here: the running one's session creation
    // never resolves, so its run never reaches completeRun/failRun.
    expect(completed).toHaveLength(1);
    expect(completed[0]).toBe(manager.getRecord(queued));
    expect(manager.getRecord(queued)!.stoppedWhileQueued).toBe(true);
  });

  it("notifies exactly once, even after the stopped agent's slot frees", async () => {
    const completed: Subagent[] = [];
    const { promise: gate, resolve } = Promise.withResolvers<void>(); // eslint-disable-line @typescript-eslint/no-invalid-void-type -- Promise.withResolvers<void> is valid; rule does not allow void in generic fn call type args

    let callCount = 0;
    const factory: SessionFactory = vi.fn(async () => {
      callCount++;
      const n = callCount;
      const stub = createSubagentSessionStub();
      stub.runTurnLoop.mockImplementation(async () => {
        if (n === 1) await gate;
        return { responseText: `result-${n}`, aborted: false, steered: false };
      });
      return toSubagentSession(stub);
    });
    ({ manager } = createManager({
      createSubagentSession: factory,
      getMaxConcurrent: () => 1,
      observer: { onSubagentCompleted: (record) => completed.push(record) },
    }));

    const running = spawnBg(manager, "a");
    const queued = spawnBg(manager, "b");
    expect(manager.getRecord(queued)!.status).toBe("queued");

    manager.abort(queued);
    const notificationsFor = (id: string) => completed.filter((record) => record.id === id);
    expect(notificationsFor(queued)).toHaveLength(1);

    // Free the slot. The limiter runs the stopped agent's thunk, which must
    // no-op on guardedRun()'s active guard rather than run and notify again.
    resolve();
    await manager.getRecord(running)!.promise;
    await manager.getRecord(queued)!.promise;

    expect(notificationsFor(queued)).toHaveLength(1);
    expect(factory).toHaveBeenCalledOnce();
  });
});

describe("SubagentManager — subagent session state", () => {
  let manager: SubagentManager;

  afterEach(() => {
    manager.dispose();
  });

  it("sets record.subagentSession with session and outputFile after session creation", async () => {
    const session = createMockSession();
    const { factory } = createSessionFactory(session, "/tmp/session.jsonl");
    ({ manager } = createManager({ createSubagentSession: factory }));

    const id = spawnBg(manager);
    await manager.getRecord(id)!.promise;

    const record = manager.getRecord(id)!;
    expect(record.subagentSession).toBeDefined();
    expect(record.subagentSession!.session).toBe(session);
    expect(record.subagentSession!.outputFile).toBe("/tmp/session.jsonl");
  });

  it("record.subagentSession is undefined before the session is created", () => {
    ({ manager } = createManager({ createSubagentSession: createBlockingFactory() }));

    const id = spawnBg(manager);
    const record = manager.getRecord(id)!;
    expect(record.subagentSession).toBeUndefined();
    manager.abort(id);
  });
});


describe("SubagentManager — onSubagentCreated observer", () => {
  let manager: SubagentManager;

  afterEach(() => {
    manager.dispose();
  });

  it("fires onSubagentCreated when a background agent is spawned", () => {
    const onCreated = vi.fn();
    ({ manager } = createManager({ observer: { onSubagentCreated: onCreated } }));

    const id = manager.spawn(STUB_SNAPSHOT, "general-purpose", "test", {
      description: "test agent",
    });

    expect(onCreated).toHaveBeenCalledOnce();
    expect(onCreated).toHaveBeenCalledWith(manager.getRecord(id));

    manager.abort(id);
  });


  it("fires onSubagentCreated before onSubagentStarted for background agents", async () => {
    const callOrder: string[] = [];
    ({ manager } = createManager({
      observer: {
        onSubagentCreated: () => { callOrder.push("created"); },
        onSubagentStarted: () => { callOrder.push("started"); },
      },
    }));

    const id = manager.spawn(STUB_SNAPSHOT, "general-purpose", "test", {
      description: "bg agent",
    });
    await manager.getRecord(id)!.promise;

    expect(callOrder).toEqual(["created", "started"]);
  });
});

describe("SubagentManager — lifecycle observer forwarding", () => {
  let manager: SubagentManager;

  beforeEach(() => {
    const { factory } = createSessionFactory(createMockSession());
    ({ manager } = createManager({ createSubagentSession: factory }));
  });

  afterEach(() => {
    manager.dispose();
  });

  it("forwards onSessionCreated from spawn options observer to Agent", async () => {
    const received: { agent: Subagent | undefined } = { agent: undefined };

    const id = manager.spawn(STUB_SNAPSHOT, "general-purpose", "test", {
      description: "test",
      observer: {
        onSessionCreated: (agent) => {
          received.agent = agent;
        },
      },
    });
    await manager.getRecord(id)!.promise;

    expect(received.agent).toBe(manager.getRecord(id));
    expect(received.agent!.id).toBe(id);
  });

});

describe("SubagentManager — toolCallId notification wiring", () => {
  let manager: SubagentManager;

  afterEach(() => {
    manager.dispose();
  });

  it("wires toolCallId on spawn when provided", () => {
    ({ manager } = createManager());

    const id = spawnBgWithToolCall(manager, "tc-42", "test", "bg");
    const record = manager.getRecord(id)!;

    expect(record.toolCallId).toBe("tc-42");
    manager.abort(id);
  });

  it("toolCallId is undefined when absent", () => {
    ({ manager } = createManager());

    const id = manager.spawn(STUB_SNAPSHOT, "general-purpose", "test", {
      description: "bg",
    });
    const record = manager.getRecord(id)!;

    expect(record.toolCallId).toBeUndefined();
    manager.abort(id);
  });
});

describe("SubagentManager — registerWorkspaceProvider", () => {
  let manager: SubagentManager;

  afterEach(() => {
    manager.dispose();
  });

  function makeProvider(): WorkspaceProvider {
    return { prepare: vi.fn(async () => undefined) };
  }

  it("returns a disposer and exposes the registered provider via getter", () => {
    ({ manager } = createManager());
    const provider = makeProvider();

    const dispose = manager.registerWorkspaceProvider(provider);

    expect(typeof dispose).toBe("function");
    expect(manager.workspaceProvider).toBe(provider);
  });

  it("throws when a provider is already registered", () => {
    ({ manager } = createManager());
    manager.registerWorkspaceProvider(makeProvider());

    expect(() => manager.registerWorkspaceProvider(makeProvider())).toThrow(
      /already registered/i,
    );
  });

  it("disposer clears the slot, allowing re-registration", () => {
    ({ manager } = createManager());
    const first = makeProvider();
    const dispose = manager.registerWorkspaceProvider(first);

    dispose();

    expect(manager.workspaceProvider).toBeUndefined();
    const second = makeProvider();
    manager.registerWorkspaceProvider(second);
    expect(manager.workspaceProvider).toBe(second);
  });

  it("stale disposer does not evict a later provider", () => {
    ({ manager } = createManager());
    const first = makeProvider();
    const disposeFirst = manager.registerWorkspaceProvider(first);
    disposeFirst();
    const second = makeProvider();
    manager.registerWorkspaceProvider(second);

    // Calling the first disposer again must not clear the second provider.
    disposeFirst();

    expect(manager.workspaceProvider).toBe(second);
  });

  it("publishes redacted live snapshots and drops terminal children", async () => {
    ({ manager } = createManager());
    const events: unknown[] = [];
    const unsubscribe = manager.subscribeLifecycle((snapshot) => events.push(snapshot));
    const id = spawnBg(manager, "private prompt", "Visible description");
    const record = manager.getRecord(id)!;

    expect(events).toEqual([
      { id, type: "general-purpose", description: "Visible description", status: "queued" },
      { id, type: "general-purpose", description: "Visible description", status: "running" },
    ]);
    expect(manager.getLifecycleSnapshots()).toEqual([events[1]]);

    await record.promise;

    expect(events.at(-1)).toEqual({ id, type: "general-purpose", description: "Visible description", status: record.status });
    expect(Object.keys(events[0] as object)).toEqual(["id", "type", "description", "status"]);
    expect(Object.isFrozen(events[0])).toBe(true);
    expect(manager.getLifecycleSnapshots()).toEqual([]);
    expect(manager.getRecord(id)).toBe(record);

    unsubscribe();
    spawnBg(manager, "another", "Another");
    expect(events).toHaveLength(3);
  });

  it("isolates throwing lifecycle subscribers through spawned completion and cleanup", async () => {
    ({ manager } = createManager());
    const events: SubagentLifecycleSnapshot[] = [];
    manager.subscribeLifecycle(() => {
      throw new Error("broken lifecycle subscriber");
    });
    manager.subscribeLifecycle((snapshot) => events.push(snapshot));

    const id = spawnBg(manager, "private prompt", "Visible description");
    const record = manager.getRecord(id)!;
    await record.promise;

    expect(events.map((snapshot) => snapshot.status)).toEqual(["queued", "running", "completed"]);
    expect(manager.getLifecycleSnapshots()).toEqual([]);
    expect(manager.getRecord(id)).toBe(record);
    expect(record.status).toBe("completed");
  });

  it("isolates throwing lifecycle subscribers during resume", async () => {
    const { factory, stub } = createSessionFactory();
    ({ manager } = createManager({ createSubagentSession: factory }));
    manager.subscribeLifecycle(() => {
      throw new Error("broken lifecycle subscriber");
    });
    const events: SubagentLifecycleSnapshot[] = [];
    manager.subscribeLifecycle((snapshot) => events.push(snapshot));
    const id = spawnBg(manager);
    await manager.getRecord(id)!.promise;
    events.length = 0;
    stub.resumeTurnLoop.mockResolvedValue("resumed result");

    const record = await manager.resume(id, "resume prompt");

    expect(events.map((snapshot) => snapshot.status)).toEqual(["running", "completed"]);
    expect(manager.getLifecycleSnapshots()).toEqual([]);
    expect(record?.result).toBe("resumed result");
  });

  it("returns defensive lifecycle snapshot arrays", () => {
    ({ manager } = createManager());
    spawnBg(manager, "prompt", "Description");
    const snapshots = manager.getLifecycleSnapshots();
    expect(Object.isFrozen(snapshots[0])).toBe(true);
    expect(snapshots).not.toBe(manager.getLifecycleSnapshots());
  });
});

describe("SubagentManager — live lifecycle projection", () => {
  let manager: SubagentManager;

  afterEach(() => {
    manager.dispose();
  });

  it("preserves the explicit launch description in the live snapshot", () => {
    ({ manager } = createManager());
    const id = spawnBg(manager, "sleep for two minutes", "Soak sleeper 1 2m");

    expect(manager.getLifecycleSnapshots()).toEqual([
      {
        id,
        type: "general-purpose",
        description: "Soak sleeper 1 2m",
        status: "running",
      },
    ]);
  });

  it("emits and removes a queued abort without consuming its authoritative record", () => {
    ({ manager } = createManager({
      createSubagentSession: createBlockingFactory(),
      getMaxConcurrent: () => 1,
    }));
    const events: SubagentLifecycleSnapshot[] = [];
    manager.subscribeLifecycle((snapshot) => events.push(snapshot));
    const running = spawnBg(manager, "running", "Running agent");
    const queued = spawnBg(manager, "secret queued prompt", "Queued agent");
    const record = manager.getRecord(queued)!;

    expect(manager.abort(queued)).toBe(true);

    expect(events.filter((snapshot) => snapshot.id === queued)).toEqual([
      { id: queued, type: "general-purpose", description: "Queued agent", status: "queued" },
      { id: queued, type: "general-purpose", description: "Queued agent", status: "stopped" },
    ]);
    expect(manager.getLifecycleSnapshots().map((snapshot) => snapshot.id)).not.toContain(queued);
    expect(manager.getRecord(queued)).toBe(record);
    expect(record.consumed).toBe(false);
    manager.abort(running);
  });

  it("emits and removes every queued record once during abortAll", async () => {
    ({ manager } = createManager({
      createSubagentSession: createBlockingFactory(),
      getMaxConcurrent: () => 1,
    }));
    const events: SubagentLifecycleSnapshot[] = [];
    manager.subscribeLifecycle((snapshot) => events.push(snapshot));
    const running = spawnBg(manager, "running");
    const queuedA = spawnBg(manager, "queued-a");
    const queuedB = spawnBg(manager, "queued-b");

    expect(manager.abortAll()).toBe(3);
    await Promise.all([manager.getRecord(queuedA)!.promise, manager.getRecord(queuedB)!.promise]);

    for (const id of [queuedA, queuedB]) {
      expect(events.filter((snapshot) => snapshot.id === id).map((snapshot) => snapshot.status)).toEqual([
        "queued",
        "stopped",
      ]);
      expect(manager.getLifecycleSnapshots().map((snapshot) => snapshot.id)).not.toContain(id);
      expect(manager.getRecord(id)!.consumed).toBe(false);
    }
    expect(manager.getRecord(running)).toBeDefined();
  });

  it("re-emits a resumed agent as running and removes it after completion", async () => {
    const { factory, stub } = createSessionFactory();
    ({ manager } = createManager({ createSubagentSession: factory }));
    const events: SubagentLifecycleSnapshot[] = [];
    manager.subscribeLifecycle((snapshot) => events.push(snapshot));
    const id = spawnBg(manager, "initial", "Visible description");
    const record = manager.getRecord(id)!;
    await record.promise;
    events.length = 0;
    const resumeGate = Promise.withResolvers<string>();
    stub.resumeTurnLoop.mockReturnValue(resumeGate.promise);

    const resumed = manager.resume(id, "private resume prompt");

    expect(events).toEqual([
      { id, type: "general-purpose", description: "Visible description", status: "running" },
    ]);
    expect(manager.getLifecycleSnapshots()).toEqual(events);

    resumeGate.resolve("resumed result");
    await resumed;

    expect(events.map((snapshot) => snapshot.status)).toEqual(["running", "completed"]);
    expect(manager.getLifecycleSnapshots()).toEqual([]);
    expect(manager.getRecord(id)).toBe(record);
    expect(record.result).toBe("resumed result");
    expect(record.consumed).toBe(false);
  });

  it("removes a resumed agent after an error while preserving its record", async () => {
    const { factory, stub } = createSessionFactory();
    ({ manager } = createManager({ createSubagentSession: factory }));
    const events: SubagentLifecycleSnapshot[] = [];
    manager.subscribeLifecycle((snapshot) => events.push(snapshot));
    const id = spawnBg(manager, "initial", "Visible description");
    const record = manager.getRecord(id)!;
    await record.promise;
    events.length = 0;
    stub.resumeTurnLoop.mockImplementation(() => {
      throw new Error("resume failed");
    });

    await manager.resume(id, "private resume prompt");

    expect(events.map((snapshot) => snapshot.status)).toEqual(["running", "error"]);
    expect(Object.keys(events[1])).toEqual(["id", "type", "description", "status"]);
    expect(Object.isFrozen(events[1])).toBe(true);
    expect(manager.getLifecycleSnapshots()).toEqual([]);
    expect(manager.getRecord(id)).toBe(record);
    expect(record.error).toContain("resume failed");
    expect(record.consumed).toBe(false);
  });
});

// V2 remains manager-local in this phase. These tests only exercise manager
// primitives and source-backed Subagent accessors; they do not expose a service
// method, event, or lifecycle-handler integration.
function lifecycleParent(ownerSessionId: string, parentEntryId: string) {
  return { parentSessionId: ownerSessionId, parentEntryId };
}

function spawnLifecycleV2(
  manager: SubagentManager,
  ownerSessionId: string,
  parentEntryId: string,
  description: string,
  options: { model?: ReturnType<typeof makeModel>; bypassQueue?: boolean } = {},
): string {
  return manager.spawn(STUB_SNAPSHOT, "general-purpose", `prompt:${description}`, {
    description,
    parentSession: lifecycleParent(ownerSessionId, parentEntryId),
    model: options.model,
    bypassQueue: options.bypassQueue,
  });
}

function countJsonNodes(value: unknown): number {
  if (value === null || typeof value !== "object") return 1;
  if (Array.isArray(value)) return 1 + value.reduce((count, item) => count + countJsonNodes(item), 0);
  return 1 + Object.values(value).reduce((count, item) => count + countJsonNodes(item), 0);
}

function isBoundedV2Payload(value: unknown): boolean {
  if (typeof value === "string") return Buffer.byteLength(value, "utf8") <= MAX_V2_STRING_UTF8_BYTES;
  if (value === null || typeof value !== "object") return true;
  return countJsonNodes(value) <= 2_048
    && Buffer.byteLength(JSON.stringify(value), "utf8") <= 32 * 1024
    && Object.values(value).every((nested) => isBoundedV2Payload(nested));
}

type LifecycleV2Update = { row: LifecycleSnapshotV2ServiceRow; delta: SubagentLifecycleDeltaV2 };

function expectSnapshotWithinV2ProtocolBounds(snapshot: ReturnType<SubagentManager["getLifecycleSnapshotV2"]>): void {
  expect(snapshot.runs.length).toBeLessThanOrEqual(MAX_SOURCE_CHILDREN_PER_SNAPSHOT);
  expect(countJsonNodes(snapshot)).toBeLessThanOrEqual(MAX_SNAPSHOT_NODES);
  expect(Buffer.byteLength(JSON.stringify(snapshot), "utf8")).toBeLessThanOrEqual(MAX_SNAPSHOT_UTF8_BYTES);
  expect(isBoundedV2Payload(snapshot)).toBe(true);
}

function sourceOrder(a: SourceChildV2, b: SourceChildV2): number {
  const group = (row: SourceChildV2) => row.lifecycle_state === "queued" ? 0 : row.lifecycle_state === "running" ? 1 : 2;
  return group(a) - group(b)
    || b.started_at.localeCompare(a.started_at)
    || a.task_id.localeCompare(b.task_id)
    || a.run_id.localeCompare(b.run_id);
}

describe("SubagentManager — lifecycle V2 manager projection", () => {
  let manager: SubagentManager | undefined;

  afterEach(() => {
    manager?.dispose();
    manager = undefined;
  });

  it("getLifecycleSnapshotV2_returns_complete_current_source_rows", async () => {
    const model = makeModel({ provider: "openai", id: "gpt-5.6", name: "GPT-5.6" });
    const first = createSessionFactory();
    const blocked = createBlockingFactory();
    let calls = 0;
    const factory: SessionFactory = vi.fn(async (params) => {
      calls++;
      return calls === 1 ? first.factory(params) : blocked(params);
    });
    ({ manager } = createManager({ createSubagentSession: factory, getMaxConcurrent: () => 1 }));
    const owner = "owner-complete";

    const terminalId = spawnLifecycleV2(manager, owner, "entry-terminal", "terminal", { model });
    await manager.getRecord(terminalId)!.promise;
    const runningId = spawnLifecycleV2(manager, owner, "entry-running", "running", { model });
    await vi.waitFor(() => expect(manager!.getRecord(runningId)!.status).toBe("running"));
    const queuedId = spawnLifecycleV2(manager, owner, "entry-queued", "queued", { model });

    const snapshot = manager.getLifecycleSnapshotV2(owner);
    expect(Object.keys(snapshot)).toEqual(["protocol", "snapshot_id", "owner_session_id", "sequence", "runs"]);
    expect(snapshot.protocol).toBe("mecha.children/v1");
    expect(snapshot.owner_session_id).toBe(owner);
    expect(snapshot.runs.map((row) => row.lifecycle_state)).toEqual(["queued", "running", "completed"]);
    expect(snapshot.runs.map((row) => row.task_id)).toEqual([queuedId, runningId, terminalId]);
    expect(snapshot.sequence).toBe(Math.max(...snapshot.runs.map((row) => row.sequence)));
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.runs)).toBe(true);
    expect(Object.isFrozen(snapshot.runs[0])).toBe(true);
    expect(Object.isFrozen(snapshot.runs[0].model)).toBe(true);
    expect(Object.isFrozen(snapshot.runs[0].compaction)).toBe(true);

    for (const row of snapshot.runs) {
      const record = manager.getRecord(row.task_id)!;
      const run = record.getLifecycleRunV2();
      expect(row).toMatchObject({
        task_id: record.id,
        run_id: run.run_id,
        model: { provider: "openai", id: "gpt-5.6", name: "GPT-5.6" },
        started_at: run.started_at,
        finished_at: run.finished_at,
        duration_ms: run.duration_ms,
        compaction: run.compaction,
        parent_entry_id: record.lifecycleParentEntryId,
        description: record.description,
        lifecycle_state: record.status,
      });
    }

    manager.releaseLifecycleV2Owner(owner, "quit");
  });

  it("getLifecycleSnapshotV2_filters_by_immutable_owner", async () => {
    ({ manager } = createManager());
    const first = spawnLifecycleV2(manager, "owner-a", "entry-a", "owner A");
    const second = spawnLifecycleV2(manager, "owner-b", "entry-b", "owner B");
    const unbound = spawnBg(manager, "legacy", "legacy");
    await Promise.all([manager.getRecord(first)!.promise, manager.getRecord(second)!.promise, manager.getRecord(unbound)!.promise]);

    expect(manager.getLifecycleSnapshotV2("owner-a").runs.map((row) => row.task_id)).toEqual([first]);
    expect(manager.getLifecycleSnapshotV2("owner-b").runs.map((row) => row.task_id)).toEqual([second]);
    expect(manager.getLifecycleSnapshotV2("owner-a").runs[0].parent_entry_id).toBe("entry-a");

    manager.releaseLifecycleV2Owner("owner-a", "quit");
    manager.releaseLifecycleV2Owner("owner-b", "quit");
  });

  it("getLifecycleSnapshotV2_does_not_fabricate_source_values", async () => {
    const runningGate = Promise.withResolvers<{ responseText: string; aborted: boolean; steered: boolean }>();
    const compactingSession = createMockSession();
    const compactingStub = createSubagentSessionStub(compactingSession);
    compactingStub.runTurnLoop.mockImplementation(async () => {
      compactingSession.emit({ type: "compaction_start", reason: "threshold" });
      return runningGate.promise;
    });
    const error = createSessionFactory();
    error.stub.runTurnLoop.mockRejectedValue(new Error("private failure text"));
    const blocked = createBlockingFactory();
    let calls = 0;
    const factory: SessionFactory = vi.fn(async (params) => {
      calls++;
      if (calls === 1) return error.factory(params);
      if (calls === 2) return blocked(params);
      return toSubagentSession(compactingStub);
    });
    ({ manager } = createManager({ createSubagentSession: factory, getMaxConcurrent: () => 2 }));
    const owner = "owner-source-only";
    const errored = spawnLifecycleV2(manager, owner, "entry-error", "errored");
    await manager.getRecord(errored)!.promise;
    const noModelRunning = spawnLifecycleV2(manager, owner, "entry-running", "no model running");
    const compacting = spawnLifecycleV2(manager, owner, "entry-compacting", "compacting");
    const noModelQueued = spawnLifecycleV2(manager, owner, "entry-queued", "no model queued");

    await vi.waitFor(() => expect(manager!.getRecord(noModelRunning)!.status).toBe("running"));
    await vi.waitFor(() => expect(manager!.getRecord(compacting)!.getLifecycleRunV2().compaction.state).toBe("compacting"));
    const rows = manager.getLifecycleSnapshotV2(owner).runs;
    const queued = rows.find((row) => row.task_id === noModelQueued)!;
    const active = rows.find((row) => row.task_id === compacting)!;
    const failed = rows.find((row) => row.task_id === errored)!;

    expect(manager.getRecord(noModelRunning)!.status).toBe("running");
    expect(queued.model).toBeNull();
    expect(queued.finished_at).toBeNull();
    expect(queued.duration_ms).toBeNull();
    expect(active.compaction).toMatchObject({ state: "compacting", started_at: expect.any(String), last_outcome: null });
    expect(failed.lifecycle_state).toBe("error");
    for (const row of rows) {
      expect(Object.keys(row)).toEqual([
        "task_id", "run_id", "model", "started_at", "finished_at", "duration_ms", "compaction",
        "parent_entry_id", "description", "lifecycle_state", "sequence", "context_ref",
      ]);
      expect(JSON.stringify(row)).not.toContain("private failure text");
      expect(JSON.stringify(row)).not.toContain("recovery");
      expect(JSON.stringify(row)).not.toContain("interrupted_unknown");
      expect(JSON.stringify(row)).not.toContain("tool_call");
    }

    manager.releaseLifecycleV2Owner(owner, "quit");
  });

  it("lifecycleV2_updates_sequence_only_on_source_change", async () => {
    const resolvedModel = makeModel({ provider: "openai", id: "gpt-5.6", name: "GPT-5.6" });
    const session = createMockSession({ model: resolvedModel });
    const { factory, stub } = createSessionFactory(session);
    const initialGate = Promise.withResolvers<{ responseText: string; aborted: boolean; steered: boolean }>();
    const resumeGate = Promise.withResolvers<string>();
    stub.runTurnLoop.mockReturnValue(initialGate.promise);
    stub.resumeTurnLoop.mockReturnValue(resumeGate.promise);
    ({ manager } = createManager({ createSubagentSession: factory }));
    const owner = "owner-updates";
    const updates: LifecycleV2Update[] = [];
    manager.subscribeLifecycleV2((row, delta) => updates.push({ row, delta }));
    const id = spawnLifecycleV2(manager, owner, "entry-updates", "updates");
    const record = manager.getRecord(id)!;

    await vi.waitFor(() => expect(record.subagentSession).toBeDefined());
    expect(updates).toHaveLength(3); // queued, running, then resolved child model
    expect(Object.keys(updates[0].delta.changes)).toEqual([
      "description", "model", "lifecycle_state", "started_at", "finished_at", "duration_ms", "compaction",
    ]);
    expect(Object.keys(updates[2].delta.changes)).toEqual(["model"]);
    const countBeforeRead = updates.length;
    const read = manager.getLifecycleSnapshotV2(owner);
    expect(read.sequence).toBe(updates.at(-1)!.row.sequence);
    expect(updates).toHaveLength(countBeforeRead);

    session.emit({ type: "compaction_start", reason: "threshold" });
    session.emit({ type: "compaction_end", aborted: false, result: { tokensBefore: 1 }, reason: "threshold" });
    session.emit({ type: "compaction_end", aborted: false, errorMessage: "failed", reason: "overflow" });
    session.emit({ type: "compaction_end", aborted: true, reason: "manual" });
    expect(updates.slice(-4).map((update) => update.delta.changes.compaction?.last_outcome)).toEqual([
      null, "completed", "failed", "aborted",
    ]);
    expect(updates.slice(-4).every((update) => Object.keys(update.delta.changes).length === 1)).toBe(true);

    initialGate.resolve({ responseText: "done", aborted: false, steered: false });
    await record.promise;
    expect(updates.at(-1)!.delta.changes).toMatchObject({ lifecycle_state: "completed" });
    const beforeResume = updates.length;
    const resumed = manager.resume(id, "continue");
    expect(updates).toHaveLength(beforeResume + 1);
    expect(Object.keys(updates.at(-1)!.delta.changes)).toEqual([
      "description", "model", "lifecycle_state", "started_at", "finished_at", "duration_ms", "compaction",
    ]);
    resumeGate.resolve("resumed");
    await resumed;
    expect(updates.at(-1)!.delta.changes).toMatchObject({ lifecycle_state: "completed" });

    const sequences = updates.map((update) => update.row.sequence);
    expect(sequences.every((sequence, index) => index === 0 || sequence > sequences[index - 1])).toBe(true);
    expect(Object.isFrozen(updates[0].row)).toBe(true);
    expect(Object.isFrozen(updates[0].delta)).toBe(true);
    manager.releaseLifecycleV2Owner(owner, "quit");
  });

  it("emits a failed result-less compaction transition without changing legacy success accounting", async () => {
    const session = createMockSession();
    const { factory, stub } = createSessionFactory(session);
    const runGate = Promise.withResolvers<{ responseText: string; aborted: boolean; steered: boolean }>();
    const onSubagentCompacted = vi.fn();
    stub.runTurnLoop.mockReturnValue(runGate.promise);
    ({ manager } = createManager({ createSubagentSession: factory, observer: { onSubagentCompacted } }));
    const owner = "owner-result-less-compaction";
    const updates: LifecycleV2Update[] = [];
    manager.subscribeLifecycleV2((row, delta) => updates.push({ row, delta }));
    const id = spawnLifecycleV2(manager, owner, "entry-result-less-compaction", "result-less compaction");
    const record = manager.getRecord(id)!;

    try {
      await vi.waitFor(() => expect(record.subagentSession).toBeDefined());
      const countBeforeTransition = updates.length;
      session.emit({ type: "compaction_start", reason: "threshold" });
      const compacting = updates.at(-1)!;
      expect(compacting.row.compaction).toMatchObject({
        state: "compacting",
        count: 0,
        last_outcome: null,
      });

      session.emit({ type: "compaction_end", aborted: false, reason: "threshold" });
      const failed = updates.at(-1)!;

      expect(updates).toHaveLength(countBeforeTransition + 2);
      expect(failed.row.sequence).toBe(compacting.row.sequence + 1);
      expect(failed.row.compaction).toEqual({
        state: "idle",
        count: 0,
        started_at: null,
        last_outcome: "failed",
      });
      expect(failed.delta.changes).toEqual({ compaction: failed.row.compaction });
      expect(record.getLifecycleRunV2().compaction).toEqual(failed.row.compaction);
      expect(record.compactionCount).toBe(0);
      expect(onSubagentCompacted).not.toHaveBeenCalled();
    } finally {
      runGate.resolve({ responseText: "done", aborted: false, steered: false });
      await record.promise;
      manager.releaseLifecycleV2Owner(owner, "quit");
    }
  });

  it("running_abort_has_one_source_update", async () => {
    const { factory, stub } = createSessionFactory();
    stub.runTurnLoop.mockImplementation(
      (_prompt: string, options: { signal?: AbortSignal }) => new Promise((resolve) => {
        options.signal!.addEventListener("abort", () => resolve({ responseText: "", aborted: true, steered: false }), { once: true });
      }),
    );
    ({ manager } = createManager({ createSubagentSession: factory }));
    const owner = "owner-abort";
    const updates: LifecycleV2Update[] = [];
    manager.subscribeLifecycleV2((row, delta) => updates.push({ row, delta }));
    const id = spawnLifecycleV2(manager, owner, "entry-abort", "abort");
    const record = manager.getRecord(id)!;
    await vi.waitFor(() => expect(record.subagentSession).toBeDefined());
    const beforeAbort = updates.length;

    expect(manager.abort(id)).toBe(true);
    await record.promise;

    expect(updates).toHaveLength(beforeAbort + 1);
    expect(updates.at(-1)!.row.lifecycle_state).toBe("stopped");
    expect(updates.at(-1)!.delta.changes.lifecycle_state).toBe("stopped");
    manager.releaseLifecycleV2Owner(owner, "quit");
  });

  it("resume_replaces_only_the_current_source_run", async () => {
    const { factory, stub } = createSessionFactory();
    const resumeGate = Promise.withResolvers<string>();
    stub.resumeTurnLoop.mockReturnValue(resumeGate.promise);
    ({ manager } = createManager({ createSubagentSession: factory }));
    const owner = "owner-resume";
    const updates: LifecycleV2Update[] = [];
    manager.subscribeLifecycleV2((row, delta) => updates.push({ row, delta }));
    const id = spawnLifecycleV2(manager, owner, "entry-resume", "resume");
    await manager.getRecord(id)!.promise;
    const previous = structuredClone(updates.at(-1)!.row);
    const resumed = manager.resume(id, "again");
    const current = updates.at(-1)!.row;

    expect(current.task_id).toBe(previous.task_id);
    expect(current.run_id).not.toBe(previous.run_id);
    expect(current.sequence).toBeGreaterThan(previous.sequence);
    expect(current.compaction).toEqual({ state: "idle", count: 0, started_at: null, last_outcome: null });
    expect(previous).toEqual(structuredClone(previous));
    expect(manager.getLifecycleSnapshotV2(owner).runs).toHaveLength(1);
    expect(JSON.stringify(manager.getLifecycleSnapshotV2(owner))).not.toContain("recovery");

    resumeGate.resolve("again");
    await resumed;
    manager.releaseLifecycleV2Owner(owner, "quit");
  });

  it("sequence_is_independent_per_owner", async () => {
    ({ manager } = createManager());
    const ownerA = "owner-independent-a";
    const ownerB = "owner-independent-b";
    const a = spawnLifecycleV2(manager, ownerA, "entry-a", "A");
    const b = spawnLifecycleV2(manager, ownerB, "entry-b", "B");
    await Promise.all([manager.getRecord(a)!.promise, manager.getRecord(b)!.promise]);
    const aBefore = manager.getLifecycleSnapshotV2(ownerA).sequence;
    const bBefore = manager.getLifecycleSnapshotV2(ownerB).sequence;
    manager.getLifecycleSnapshotV2(ownerA);
    manager.getLifecycleSnapshotV2(ownerB);
    expect(manager.getLifecycleSnapshotV2(ownerA).sequence).toBe(aBefore);
    expect(manager.getLifecycleSnapshotV2(ownerB).sequence).toBe(bBefore);

    await manager.resume(a, "resume A");
    expect(manager.getLifecycleSnapshotV2(ownerA).sequence).toBeGreaterThan(aBefore);
    expect(manager.getLifecycleSnapshotV2(ownerB).sequence).toBe(bBefore);

    manager.releaseLifecycleV2Owner(ownerA, "quit");
    manager.releaseLifecycleV2Owner(ownerB, "quit");
  });

  it("uses the 256-run protocol ceiling while full rows remain byte-bounded", async () => {
    const model = makeModel({ provider: "openai", id: "gpt-5.6", name: "GPT-5.6" });
    const factory: SessionFactory = vi.fn(async () => {
      const session = createMockSession();
      const stub = createSubagentSessionStub(session);
      stub.runTurnLoop.mockImplementation(async () => {
        session.emit({ type: "compaction_start", reason: "threshold" });
        session.emit({ type: "compaction_end", aborted: false, result: { tokensBefore: 1 }, reason: "threshold" });
        return { responseText: "done", aborted: false, steered: false };
      });
      return toSubagentSession(stub);
    });
    ({ manager } = createManager({ createSubagentSession: factory, getMaxConcurrent: () => 107 }));
    const owner = "owner-107";
    try {
      const ids = Array.from({ length: 107 }, (_, index) => spawnLifecycleV2(manager!, owner, `entry-${index}`, `short ${index}`, { model }));
      const promises = ids.map((id) => {
        const promise = manager!.getRecord(id)?.promise;
        if (promise === undefined) throw new Error("Spawned lifecycle V2 record has no completion promise.");
        return promise;
      });
      await Promise.all(promises);

      const snapshot = manager.getLifecycleSnapshotV2(owner);
    expect(MAX_SOURCE_CHILDREN_PER_SNAPSHOT).toBe(256);
    expect(snapshot.runs.length).toBeGreaterThan(0);
    expect(snapshot.runs.length).toBeLessThan(ids.length);
    expectSnapshotWithinV2ProtocolBounds(snapshot);
    for (const row of snapshot.runs) {
      const record = manager.getRecord(row.task_id)!;
      const run = record.getLifecycleRunV2();
      expect(row).toMatchObject({ ...run, parent_entry_id: record.lifecycleParentEntryId, description: record.description, lifecycle_state: record.status });
      expect(row.compaction).toEqual({ state: "idle", count: 1, started_at: null, last_outcome: "completed" });
    }
    } finally {
      manager.releaseLifecycleV2Owner(owner, "quit");
    }
  });

  it("omits whole full rows for the byte limit", async () => {
    const owner = "owner-108";
    vi.useFakeTimers();
    try {
      const model = makeModel({ provider: "openai", id: "gpt-5.6", name: "GPT-5.6" });
      const factory: SessionFactory = vi.fn(async () => {
        const session = createMockSession();
        const stub = createSubagentSessionStub(session);
        stub.runTurnLoop.mockImplementation(async () => {
          session.emit({ type: "compaction_start", reason: "threshold" });
          session.emit({ type: "compaction_end", aborted: false, result: { tokensBefore: 1 }, reason: "threshold" });
          return { responseText: "done", aborted: false, steered: false };
        });
        return toSubagentSession(stub);
      });
      ({ manager } = createManager({ createSubagentSession: factory, getMaxConcurrent: () => 108 }));
      const ids: string[] = [];
      for (let index = 0; index < 108; index++) {
        vi.setSystemTime(1_000 + index);
        ids.push(spawnLifecycleV2(manager, owner, `entry-${index}`, `full ${index}`, { model }));
      }
      const promises = ids.map((id) => {
        const promise = manager!.getRecord(id)?.promise;
        if (promise === undefined) throw new Error("Spawned lifecycle V2 record has no completion promise.");
        return promise;
      });
      await Promise.all(promises);
      const before = ids.map((id) => structuredClone(manager!.getRecord(id)!.getLifecycleRunV2()));
      const expected = ids
        .map((id) => ({ id, row: manager!.getRecord(id)!.getLifecycleRunV2() }))
        .sort((a, b) => sourceOrder({ ...a.row, parent_entry_id: "", description: "", lifecycle_state: "completed", sequence: 0 }, { ...b.row, parent_entry_id: "", description: "", lifecycle_state: "completed", sequence: 0 }))
        .map(({ id }) => id);

      const snapshot = manager.getLifecycleSnapshotV2(owner);
      expect(snapshot.runs).toHaveLength(73);
      expect(snapshot.runs.map((row) => row.task_id)).toEqual(expected.slice(0, snapshot.runs.length));
      expect(snapshot.runs.every((row) => Object.keys(row).length === 12)).toBe(true);
      expectSnapshotWithinV2ProtocolBounds(snapshot);
      expect(ids.map((id) => manager!.getRecord(id)!.getLifecycleRunV2())).toEqual(before);
      expect(manager.getLifecycleSnapshots()).toEqual([]);
    } finally {
      manager?.releaseLifecycleV2Owner(owner, "quit");
      vi.useRealTimers();
    }
  });

  it("suppresses unsafe V2 deltas without truncating source records", async () => {
    const maxStringBytes = 8_192;
    const cases = [
      {
        name: "oversized source string",
        owner: "owner-oversized-string",
        parentEntry: "entry-oversized-string",
        description: "d".repeat(maxStringBytes + 1),
        model: undefined,
        expectedSnapshotRows: 0,
        deliveredLifecycleStates: [],
      },
      {
        name: "oversized source row",
        owner: "owner-oversized-row",
        parentEntry: "e".repeat(maxStringBytes),
        description: "d".repeat(maxStringBytes),
        model: makeModel({
          provider: "p".repeat(maxStringBytes),
          id: "i".repeat(maxStringBytes),
          name: "n".repeat(maxStringBytes),
        }),
        expectedSnapshotRows: 0,
        deliveredLifecycleStates: [],
      },
      {
        name: "oversized source envelope",
        owner: "o".repeat(maxStringBytes),
        parentEntry: "e".repeat(maxStringBytes),
        description: "d".repeat(maxStringBytes),
        model: makeModel({ provider: "p".repeat(maxStringBytes), id: "", name: "" }),
        expectedSnapshotRows: 0,
        deliveredLifecycleStates: [],
      },
    ];

    for (const testCase of cases) {
      const fixture = createManager();
      manager = fixture.manager;
      try {
        const updates: LifecycleV2Update[] = [];
        manager.subscribeLifecycleV2((row, delta) => updates.push({ row, delta }));
        const id = spawnLifecycleV2(manager, testCase.owner, testCase.parentEntry, testCase.description, {
          model: testCase.model,
        });
        const record = manager.getRecord(id)!;
        await record.promise;

        expect(
          updates.map((update) => update.delta.changes.lifecycle_state),
          testCase.name,
        ).toEqual(testCase.deliveredLifecycleStates);
        for (const update of updates) {
          expect(isBoundedV2Payload(update.row), testCase.name).toBe(true);
          expect(isBoundedV2Payload(update.delta), testCase.name).toBe(true);
        }
        expect(record.description, testCase.name).toBe(testCase.description);
        expect(record.lifecycleParentEntryId, testCase.name).toBe(testCase.parentEntry);
        expect(record.getLifecycleRunV2().model, testCase.name).toEqual(
          testCase.model === undefined
            ? null
            : { provider: testCase.model.provider, id: testCase.model.id, name: testCase.model.name },
        );

        const snapshot = manager.getLifecycleSnapshotV2(testCase.owner);
        expect(snapshot.runs, testCase.name).toHaveLength(testCase.expectedSnapshotRows);
        expect(Buffer.byteLength(JSON.stringify(snapshot), "utf8"), testCase.name).toBeLessThanOrEqual(32 * 1024);
        if (testCase.expectedSnapshotRows === 1) {
          expect(snapshot.runs[0]).toMatchObject({
            task_id: id,
            parent_entry_id: testCase.parentEntry,
            description: testCase.description,
          });
        }
      } finally {
        manager.releaseLifecycleV2Owner(testCase.owner, "quit");
        manager.dispose();
        manager = undefined;
      }
    }
  });

  it("snapshot_skips_an_oversized_row_and_considers_later_rows", async () => {
    vi.useFakeTimers();
    try {
      ({ manager } = createManager({ getMaxConcurrent: () => 2 }));
      const owner = "owner-oversized";
      vi.setSystemTime(1_000);
      const valid = spawnLifecycleV2(manager, owner, "entry-valid", "valid");
      await manager.getRecord(valid)!.promise;
      vi.setSystemTime(2_000);
      const oversizedDescription = "x".repeat(8_193);
      const oversized = spawnLifecycleV2(manager, owner, "entry-oversized", oversizedDescription);
      await manager.getRecord(oversized)!.promise;

      const snapshot = manager.getLifecycleSnapshotV2(owner);
      expect(snapshot.runs.map((row) => row.task_id)).toEqual([valid]);
      expect(manager.getRecord(oversized)!.description).toBe(oversizedDescription);
      expect(manager.getRecord(oversized)!.getLifecycleRunV2().task_id).toBe(oversized);
      manager.releaseLifecycleV2Owner(owner, "quit");
    } finally {
      vi.useRealTimers();
    }
  });

  it("snapshot_counts_real_utf8_json_bytes", async () => {
    const model = makeModel({ provider: "openai", id: "gpt-5.6", name: "GPT-5.6" });
    ({ manager } = createManager({ getMaxConcurrent: () => 107 }));
    const owner = "owner-escaped-json";
    const description = "\"\\é".repeat(100);
    const ids = Array.from({ length: 107 }, (_, index) => spawnLifecycleV2(manager!, owner, `entry-${index}`, `${description}${index}`, { model }));
    const promises = ids.map((id) => {
      const promise = manager!.getRecord(id)?.promise;
      if (promise === undefined) throw new Error("Spawned lifecycle V2 record has no completion promise.");
      return promise;
    });
    await Promise.all(promises);
    const all = ids
      .map((id) => ({ id, run: manager!.getRecord(id)!.getLifecycleRunV2() }))
      .sort((a, b) => sourceOrder({ ...a.run, parent_entry_id: "", description: "", lifecycle_state: "completed", sequence: 0 }, { ...b.run, parent_entry_id: "", description: "", lifecycle_state: "completed", sequence: 0 }));

    const snapshot = manager.getLifecycleSnapshotV2(owner);
    expect(snapshot.runs.length).toBeGreaterThan(0);
    expect(snapshot.runs.length).toBeLessThan(107);
    expect(Buffer.byteLength(JSON.stringify(snapshot), "utf8")).toBeLessThanOrEqual(32 * 1024);
    expect(snapshot.runs.map((row) => row.task_id)).toEqual(all.slice(0, snapshot.runs.length).map(({ id }) => id));
    for (const row of snapshot.runs) expect(row.description).toBe(manager.getRecord(row.task_id)!.description);
    manager.releaseLifecycleV2Owner(owner, "quit");
  });

  it("fences delayed settlement after dispose so it cannot reclaim an owner or emit another delta", async () => {
    const { factory, stub } = createSessionFactory();
    const runGate = Promise.withResolvers<{ responseText: string; aborted: boolean; steered: boolean }>();
    stub.runTurnLoop.mockReturnValue(runGate.promise);
    ({ manager } = createManager({ createSubagentSession: factory }));
    const owner = "owner-after-dispose";
    const updates: LifecycleV2Update[] = [];
    manager.subscribeLifecycleV2((row, delta) => updates.push({ row, delta }));
    const id = spawnLifecycleV2(manager, owner, "entry-after-dispose", "after dispose");
    const record = manager.getRecord(id)!;
    await vi.waitFor(() => expect(record.subagentSession).toBeDefined());
    const beforeDispose = updates.length;

    manager.dispose();
    runGate.resolve({ responseText: "settled late", aborted: false, steered: false });
    await record.promise;

    expect(updates).toHaveLength(beforeDispose);
    const replacement = createManager().manager;
    try {
      replacement.bindLifecycleV2Owner(owner);
      expect(replacement.getLifecycleSnapshotV2(owner).sequence).toBe(1);
    } finally {
      replacement.releaseLifecycleV2Owner(owner, "quit");
      replacement.dispose();
    }
  });

  it("reload_sequence_primitive_preserves_high_water_only_when_explicitly_released_as_reload", async () => {
    const owner = "owner-reload";
    const first = createManager();
    const second = createManager();
    manager = first.manager;
    try {
      first.manager.bindLifecycleV2Owner(owner);
      const id = spawnLifecycleV2(first.manager, owner, "entry-reload", "reload");
      await first.manager.getRecord(id)!.promise;
      const beforeReload = first.manager.getLifecycleSnapshotV2(owner).sequence;
      first.manager.releaseLifecycleV2Owner(owner, "reload");
      second.manager.bindLifecycleV2Owner(owner);
      expect(second.manager.getLifecycleSnapshotV2(owner)).toMatchObject({ owner_session_id: owner, runs: [] });
      expect(second.manager.getLifecycleSnapshotV2(owner).sequence).toBeGreaterThan(beforeReload);

      const discarded = "owner-discarded";
      first.manager.bindLifecycleV2Owner(discarded);
      first.manager.releaseLifecycleV2Owner(discarded, "quit");
      second.manager.bindLifecycleV2Owner(discarded);
      expect(second.manager.getLifecycleSnapshotV2(discarded).sequence).toBe(1);
      second.manager.releaseLifecycleV2Owner(owner, "quit");
      second.manager.releaseLifecycleV2Owner(discarded, "quit");
    } finally {
      first.manager.dispose();
      second.manager.dispose();
      manager = undefined;
    }
  });

  it("sequence_registry_is_bounded_without_evicting_claims", () => {
    ({ manager } = createManager());
    const unclaimed = Array.from({ length: 100 }, (_, index) => `owner-lru-${index}`);
    for (const owner of unclaimed) {
      manager.bindLifecycleV2Owner(owner);
      manager.releaseLifecycleV2Owner(owner, "reload");
    }
    manager.bindLifecycleV2Owner("owner-lru-new");
    expect(manager.getLifecycleSnapshotV2("owner-lru-0").sequence).toBe(0);
    expect(manager.getLifecycleSnapshotV2("owner-lru-1").sequence).toBe(1);
    manager.releaseLifecycleV2Owner("owner-lru-new", "quit");

    const claimed = Array.from({ length: 100 }, (_, index) => `owner-claimed-${index}`);
    for (const owner of claimed) manager.bindLifecycleV2Owner(owner);
    expect(() => manager!.bindLifecycleV2Owner("owner-over-capacity")).toThrow(/claimed/i);
    for (const owner of claimed) manager.releaseLifecycleV2Owner(owner, "quit");
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

function controlContext(snapshot: ReturnType<SubagentManager["getLifecycleSnapshotV2"]>, taskId: string): ContextRefV1 {
  const contextRef = snapshot.runs.find((row) => row.task_id === taskId)?.context_ref;
  if (contextRef === null || contextRef === undefined) throw new Error("Expected a live child context reference.");
  return contextRef;
}

function createControlSessionFactory() {
  const session = createMockSession();
  const stub = createSubagentSessionStub(session);
  const appendControlResult = vi.fn<(payload: ControlResultPayloadV1) => Promise<void>>().mockResolvedValue(undefined);
  const findControlResultById = vi.fn<(resultId: string) => ControlResultPayloadV1 | undefined>();
  Object.assign(stub, { appendControlResult, findControlResultById });
  return {
    session,
    appendControlResult,
    findControlResultById,
    factory: vi.fn(async () => toSubagentSession(stub)),
  };
}

function createControlChild(
  control: ReturnType<typeof createControlSessionFactory>,
  overrides: Record<string, unknown>,
): SubagentSession {
  const stub = createSubagentSessionStub(control.session);
  Object.assign(stub, {
    appendControlResult: control.appendControlResult,
    findControlResultById: control.findControlResultById,
    ...overrides,
  });
  return toSubagentSession(stub);
}

/**
 * This double preserves Pi's streamed `sendCustomMessage(..., { triggerTurn: false })`
 * contract: accepting the call queues the custom message, then persistence and message_end
 * arrive together later when the stream flushes.
 */
function createStreamDeferredControlChild() {
  const sessionManager = SessionManager.inMemory();
  const listeners = new Set<(event: unknown) => void>();
  const deferred: Array<{
    customType: string;
    content: string;
    display: boolean;
    details: unknown;
  }> = [];
  const session = {
    messages: [] as unknown[],
    sessionManager,
    subscribe: vi.fn((listener: (event: unknown) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    sendCustomMessage: vi.fn(async (
      message: { customType: string; content: string; display: boolean; details: unknown },
      options: { triggerTurn?: boolean } | undefined,
    ) => {
      if (options?.triggerTurn !== false) throw new Error("Control results must not trigger a turn.");
      deferred.push(message);
    }),
    prompt: vi.fn(),
    abort: vi.fn(),
    steer: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    getSessionStats: vi.fn(() => ({
      tokens: { input: 0, output: 0, cacheWrite: 0 },
      contextUsage: { percent: null },
    })),
    getToolDefinition: vi.fn((_name: string): undefined => undefined),
  };
  const child = new SubagentSession(session as unknown as AgentSession, {
    outputFile: undefined,
    sessionId: "stream-deferred-child",
    sessionDir: "/sessions/stream-deferred-child",
    agentName: "Plan",
    agentMaxTurns: undefined,
    parentContext: undefined,
    lifecycle: createChildLifecycleMock(),
  });
  const flushOne = (): void => {
    const message = deferred.shift();
    if (!message) throw new Error("Expected a deferred custom message.");
    const customMessage = { role: "custom" as const, ...message };
    session.messages.push(customMessage);
    // Pi emits message_end before its SessionManager write completes.
    for (const listener of listeners) listener({ type: "message_end", message: customMessage });
    sessionManager.appendCustomMessageEntry(
      message.customType,
      message.content,
      message.display,
      message.details,
    );
  };
  return { child, deferred, flushOne, session, sessionManager };
}

describe("SubagentManager — control-result V1", () => {
  let manager: SubagentManager | undefined;

  afterEach(() => {
    manager?.dispose();
    manager = undefined;
  });

  it("creates an opaque service-only reference only after the exact child session binds", async () => {
    const gate = Promise.withResolvers<{ responseText: string; aborted: boolean; steered: boolean }>();
    const control = createControlSessionFactory();
    const child = createControlChild(control, { runTurnLoop: vi.fn(() => gate.promise) });
    const factory: SessionFactory = vi.fn(async () => child);
    ({ manager } = createManager({ createSubagentSession: factory }));
    const updates: LifecycleV2Update[] = [];
    manager.subscribeLifecycleV2((row, delta) => updates.push({ row, delta }));

    const id = spawnLifecycleV2(manager, "owner-control", "entry-control", "control result");
    expect(manager.getLifecycleSnapshotV2("owner-control").runs[0]?.context_ref).toBeNull();

    await vi.waitFor(() => expect(manager!.getRecord(id)?.subagentSession).toBeDefined());
    const contextRef = controlContext(manager.getLifecycleSnapshotV2("owner-control"), id);
    expect(contextRef).toMatch(/^ctx1_[A-Za-z0-9_-]{43}$/);
    expect(contextRef).toHaveLength(48);
    expect(contextRef).not.toContain(id);
    expect(updates.at(-1)?.row.context_ref).toBe(contextRef);
    expect(updates.at(-1)?.delta.context_ref).toBe(contextRef);

    gate.resolve({ responseText: "done", aborted: false, steered: false });
    await manager.getRecord(id)?.promise;
    expect(manager.getLifecycleSnapshotV2("owner-control").runs[0]?.context_ref).toBeNull();
  });

  it("validates before appending to the exact live child and returns a structured accepted outcome", async () => {
    const gate = Promise.withResolvers<{ responseText: string; aborted: boolean; steered: boolean }>();
    const control = createControlSessionFactory();
    const child = createControlChild(control, { runTurnLoop: vi.fn(() => gate.promise) });
    ({ manager } = createManager({ createSubagentSession: vi.fn(async () => child) }));
    const id = spawnLifecycleV2(manager, "owner-live", "entry-live", "live child");
    await vi.waitFor(() => expect(manager!.getRecord(id)?.subagentSession).toBeDefined());
    const contextRef = controlContext(manager.getLifecycleSnapshotV2("owner-live"), id);
    const payload = makeControlResultPayload();

    await expect(manager.appendControlResultV1(contextRef, payload)).resolves.toEqual({
      kind: "accepted",
      result_id: payload.result_id,
    });
    expect(control.appendControlResult).toHaveBeenCalledExactlyOnceWith(payload);
    expect(control.findControlResultById).toHaveBeenCalledTimes(2);
    expect(control.findControlResultById).toHaveBeenLastCalledWith(payload.result_id);

    gate.resolve({ responseText: "done", aborted: false, steered: false });
    await manager.getRecord(id)?.promise;
  });

  it("rejects a closed-payload violation and size violation without touching child history", async () => {
    const gate = Promise.withResolvers<{ responseText: string; aborted: boolean; steered: boolean }>();
    const control = createControlSessionFactory();
    const child = createControlChild(control, { runTurnLoop: vi.fn(() => gate.promise) });
    ({ manager } = createManager({ createSubagentSession: vi.fn(async () => child) }));
    const id = spawnLifecycleV2(manager, "owner-invalid", "entry-invalid", "invalid result");
    await vi.waitFor(() => expect(manager!.getRecord(id)?.subagentSession).toBeDefined());
    const contextRef = controlContext(manager.getLifecycleSnapshotV2("owner-invalid"), id);
    const payload = makeControlResultPayload();

    const unknownField = { ...payload, unexpected: true };
    const missingError = { ...payload, status: "error" };
    const coercedEpoch = { ...payload, target_session_epoch: "1" };
    const detailsArray = { ...payload, details: [] };
    const oversized = { ...payload, content: "x".repeat(16 * 1024 + 1) };
    for (const invalidPayload of [unknownField, missingError, coercedEpoch, detailsArray, oversized]) {
      const outcome = await Reflect.apply(manager.appendControlResultV1, manager, [contextRef, invalidPayload]);
      expect(outcome).toMatchObject({ kind: "rejected" });
    }
    const outcomes = await Promise.all([
      Reflect.apply(manager.appendControlResultV1, manager, [contextRef, unknownField]),
      Reflect.apply(manager.appendControlResultV1, manager, [contextRef, missingError]),
      Reflect.apply(manager.appendControlResultV1, manager, [contextRef, coercedEpoch]),
      Reflect.apply(manager.appendControlResultV1, manager, [contextRef, detailsArray]),
      Reflect.apply(manager.appendControlResultV1, manager, [contextRef, oversized]),
    ]);
    expect(outcomes).toEqual([
      expect.objectContaining({ kind: "rejected", error: expect.objectContaining({ code: "INVALID_ENVELOPE" }) }),
      expect.objectContaining({ kind: "rejected", error: expect.objectContaining({ code: "INVALID_ENVELOPE" }) }),
      expect.objectContaining({ kind: "rejected", error: expect.objectContaining({ code: "INVALID_ENVELOPE" }) }),
      expect.objectContaining({ kind: "rejected", error: expect.objectContaining({ code: "INVALID_ENVELOPE" }) }),
      expect.objectContaining({ kind: "rejected", error: expect.objectContaining({ code: "PAYLOAD_TOO_LARGE" }) }),
    ]);
    expect(control.appendControlResult).not.toHaveBeenCalled();

    gate.resolve({ responseText: "done", aborted: false, steered: false });
    await manager.getRecord(id)?.promise;
  });

  it("fences forged, resumed, terminal, released, and owner-released contexts without parent fallback", async () => {
    const gate = Promise.withResolvers<{ responseText: string; aborted: boolean; steered: boolean }>();
    const resumeGate = Promise.withResolvers<string>();
    const control = createControlSessionFactory();
    const child = createControlChild(control, {
      runTurnLoop: vi.fn(() => gate.promise),
      resumeTurnLoop: vi.fn(() => resumeGate.promise),
    });
    ({ manager } = createManager({ createSubagentSession: vi.fn(async () => child) }));
    const owner = "owner-stale";
    const id = spawnLifecycleV2(manager, owner, "entry-stale", "stale child");
    await vi.waitFor(() => expect(manager!.getRecord(id)?.subagentSession).toBeDefined());
    const payload = makeControlResultPayload();
    const initialRef = controlContext(manager.getLifecycleSnapshotV2(owner), id);
    const staleOutcomes: unknown[] = [];

    staleOutcomes.push(await Reflect.apply(manager.appendControlResultV1, manager, ["ctx1_" + "x".repeat(43), payload]));
    gate.resolve({ responseText: "done", aborted: false, steered: false });
    await manager.getRecord(id)?.promise;
    staleOutcomes.push(await manager.appendControlResultV1(initialRef, payload));
    const resumed = manager.resume(id, "resume");
    await vi.waitFor(() => expect(manager!.getRecord(id)?.status).toBe("running"));
    const resumedRef = controlContext(manager.getLifecycleSnapshotV2(owner), id);
    manager.releaseLifecycleV2Owner(owner, "reload");
    staleOutcomes.push(await manager.appendControlResultV1(resumedRef, payload));
    staleOutcomes.push(await Reflect.apply(manager.appendControlResultV1, manager, ["not-a-context", payload]));

    expect(staleOutcomes).toEqual([
      expect.objectContaining({ kind: "rejected", error: expect.objectContaining({ code: "STALE_CHILD_CONTEXT" }) }),
      expect.objectContaining({ kind: "rejected", error: expect.objectContaining({ code: "STALE_CHILD_CONTEXT" }) }),
      expect.objectContaining({ kind: "rejected", error: expect.objectContaining({ code: "STALE_CHILD_CONTEXT" }) }),
      expect.objectContaining({ kind: "rejected", error: expect.objectContaining({ code: "STALE_CHILD_CONTEXT" }) }),
    ]);
    expect(control.appendControlResult).not.toHaveBeenCalled();

    resumeGate.resolve("resumed");
    await resumed;
  });

  it("uses persisted entries on the exact compacted child branch for duplicate and conflict results", async () => {
    const gate = Promise.withResolvers<{ responseText: string; aborted: boolean; steered: boolean }>();
    const control = createStreamDeferredControlChild();
    vi.spyOn(control.child, "runTurnLoop").mockReturnValue(gate.promise);
    const payload = makeControlResultPayload();
    control.sessionManager.appendCustomMessageEntry("other", "before", false);
    control.sessionManager.appendCustomMessageEntry(
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
    const firstKeptEntryId = control.sessionManager.appendCustomMessageEntry("other", "after", false);
    control.sessionManager.appendCompaction("summary", firstKeptEntryId, 1);
    control.session.messages = [...control.sessionManager.buildSessionContext().messages];
    ({ manager } = createManager({ createSubagentSession: vi.fn(async () => control.child) }));
    const id = spawnLifecycleV2(manager, "owner-persisted", "entry-persisted", "persisted child");
    await vi.waitFor(() => expect(manager!.getRecord(id)?.subagentSession).toBeDefined());
    const contextRef = controlContext(manager.getLifecycleSnapshotV2("owner-persisted"), id);

    await expect(manager.appendControlResultV1(contextRef, payload)).resolves.toEqual({
      kind: "already_present",
      result_id: payload.result_id,
    });
    await expect(manager.appendControlResultV1(contextRef, { ...payload, content: "changed" })).resolves.toEqual({
      kind: "rejected",
      error: {
        code: "CONFLICT",
        message: "A different control result already uses this result_id.",
        retryable: false,
      },
    });
    expect(control.session.sendCustomMessage).not.toHaveBeenCalled();

    gate.resolve({ responseText: "done", aborted: false, steered: false });
    await manager.getRecord(id)?.promise;
  });

  it("keeps a duplicate claim while Pi has queued a streamed control result", async () => {
    const gate = Promise.withResolvers<{ responseText: string; aborted: boolean; steered: boolean }>();
    const control = createStreamDeferredControlChild();
    vi.spyOn(control.child, "runTurnLoop").mockReturnValue(gate.promise);
    ({ manager } = createManager({ createSubagentSession: vi.fn(async () => control.child) }));
    const id = spawnLifecycleV2(manager, "owner-deferred", "entry-deferred", "deferred child");
    await vi.waitFor(() => expect(manager!.getRecord(id)?.subagentSession).toBeDefined());
    const contextRef = controlContext(manager.getLifecycleSnapshotV2("owner-deferred"), id);
    const payload = makeControlResultPayload();

    await expect(manager.appendControlResultV1(contextRef, payload)).resolves.toEqual({
      kind: "accepted",
      result_id: payload.result_id,
    });
    expect(control.deferred).toHaveLength(1);
    await expect(manager.appendControlResultV1(contextRef, payload)).resolves.toEqual({
      kind: "already_present",
      result_id: payload.result_id,
    });
    await expect(manager.appendControlResultV1(contextRef, { ...payload, content: "changed" })).resolves.toEqual({
      kind: "rejected",
      error: {
        code: "CONFLICT",
        message: "A different control result is already being appended for this result_id.",
        retryable: false,
      },
    });
    expect(control.session.sendCustomMessage).toHaveBeenCalledExactlyOnceWith({
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

    control.flushOne();
    await Promise.resolve();
    await expect(manager.appendControlResultV1(contextRef, payload)).resolves.toEqual({
      kind: "already_present",
      result_id: payload.result_id,
    });

    gate.resolve({ responseText: "done", aborted: false, steered: false });
    await manager.getRecord(id)?.promise;
  });

  it("uses child history and a bounded in-flight set for local duplicate protection", async () => {
    const gate = Promise.withResolvers<{ responseText: string; aborted: boolean; steered: boolean }>();
    const control = createControlSessionFactory();
    const appendGate = Promise.withResolvers<undefined>();
    control.appendControlResult.mockImplementation(async () => appendGate.promise);
    const child = createControlChild(control, { runTurnLoop: vi.fn(() => gate.promise) });
    ({ manager } = createManager({ createSubagentSession: vi.fn(async () => child) }));
    const id = spawnLifecycleV2(manager, "owner-duplicate", "entry-duplicate", "duplicate child");
    await vi.waitFor(() => expect(manager!.getRecord(id)?.subagentSession).toBeDefined());
    const contextRef = controlContext(manager.getLifecycleSnapshotV2("owner-duplicate"), id);
    const payload = makeControlResultPayload();

    const first = manager.appendControlResultV1(contextRef, payload);
    const second = manager.appendControlResultV1(contextRef, payload);
    const conflict = manager.appendControlResultV1(contextRef, { ...payload, content: "changed" });
    appendGate.resolve(undefined);
    await expect(first).resolves.toEqual({ kind: "accepted", result_id: payload.result_id });
    await expect(second).resolves.toEqual({ kind: "already_present", result_id: payload.result_id });
    await expect(conflict).resolves.toMatchObject({ kind: "rejected", error: { code: "CONFLICT" } });
    expect(control.appendControlResult).toHaveBeenCalledExactlyOnceWith(payload);

    control.findControlResultById.mockReturnValue(payload);
    await expect(manager.appendControlResultV1(contextRef, payload)).resolves.toEqual({
      kind: "already_present",
      result_id: payload.result_id,
    });

    gate.resolve({ responseText: "done", aborted: false, steered: false });
    await manager.getRecord(id)?.promise;
  });

  it("returns a retryable delivery failure and clears the in-flight claim when Pi rejects the append", async () => {
    const gate = Promise.withResolvers<{ responseText: string; aborted: boolean; steered: boolean }>();
    const control = createControlSessionFactory();
    control.appendControlResult.mockRejectedValueOnce(new Error("Pi unavailable"));
    const child = createControlChild(control, { runTurnLoop: vi.fn(() => gate.promise) });
    ({ manager } = createManager({ createSubagentSession: vi.fn(async () => child) }));
    const id = spawnLifecycleV2(manager, "owner-delivery", "entry-delivery", "delivery failure");
    await vi.waitFor(() => expect(manager!.getRecord(id)?.subagentSession).toBeDefined());
    const contextRef = controlContext(manager.getLifecycleSnapshotV2("owner-delivery"), id);
    const payload = makeControlResultPayload();

    await expect(manager.appendControlResultV1(contextRef, payload)).resolves.toEqual({
      kind: "rejected",
      error: {
        code: "RESULT_DELIVERY_FAILED",
        message: "The child session did not accept the control result.",
        retryable: true,
      },
    });
    await expect(manager.appendControlResultV1(contextRef, payload)).resolves.toEqual({
      kind: "accepted",
      result_id: payload.result_id,
    });
    expect(control.appendControlResult).toHaveBeenCalledTimes(2);

    gate.resolve({ responseText: "done", aborted: false, steered: false });
    await manager.getRecord(id)?.promise;
  });
});
