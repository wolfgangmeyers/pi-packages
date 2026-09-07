import { describe, expect, it, vi } from "vitest";
import type { ParentSnapshot } from "#src/lifecycle/parent-snapshot";
import type { WorkspaceProvider } from "#src/lifecycle/workspace";
import { createSubagentRuntime, type SubagentRuntime } from "#src/runtime";
import type {
  ContextRefV1,
  ControlResultPayloadV1,
  LifecycleSnapshotV2ServiceResult,
  SubagentsService,
} from "#src/service/service";
import type { ServiceRuntimeLike, SubagentManagerLike } from "#src/service/service-adapter";
import { SubagentsServiceAdapter, toSubagentRecord } from "#src/service/service-adapter";
import type { SessionContext, Subagent } from "#src/types";
import { makeModel } from "#test/helpers/make-model";
import { createTestSubagent } from "#test/helpers/make-subagent";
import { createMockSession, createSubagentSessionStub, toSubagentSession } from "#test/helpers/mock-session";
import { STUB_SNAPSHOT } from "#test/helpers/stub-ctx";

describe("toSubagentRecord", () => {
  const baseRecord = (() => {
    const r = createTestSubagent({
      id: "abc-123",
      type: "Plan",
      description: "Check stale TODOs",
      result: "Found 3 stale TODOs",
      toolUses: 5,
      lifetimeUsage: { input: 100, output: 200, cacheWrite: 50 },
      compactionCount: 1,
    });
    return r;
  })();

  it("includes all serializable fields", () => {
    const result = toSubagentRecord(baseRecord);
    expect(result).toEqual({
      id: "abc-123",
      type: "Plan",
      description: "Check stale TODOs",
      status: "completed",
      result: "Found 3 stale TODOs",
      toolUses: 5,
      startedAt: 1000,
      completedAt: 2000,
      lifetimeUsage: { input: 100, output: 200, cacheWrite: 50 },
      compactionCount: 1,
    });
  });

  it("strips the session from the serialized record", () => {
    const record = createTestSubagent();
    record.subagentSession = toSubagentSession(createSubagentSessionStub(createMockSession()));
    const result = toSubagentRecord(record);
    expect(result).not.toHaveProperty("subagentSession");
  });

  it("strips abortController from the record", () => {
    const record = createTestSubagent();
    const result = toSubagentRecord(record);
    expect(result).not.toHaveProperty("abortController");
  });

  it("strips promise from the record", () => {
    const record = createTestSubagent();
    const result = toSubagentRecord(record);
    expect(result).not.toHaveProperty("promise");
  });

  it("strips abortController, promise, and collaborator fields from the record", () => {
    const record = createTestSubagent();
    const result = toSubagentRecord(record);
    expect(result).not.toHaveProperty("abortController");
    expect(result).not.toHaveProperty("promise");
    expect(result).not.toHaveProperty("execution");
    expect(result).not.toHaveProperty("notification");
  });

  it("strips invocation and collaborator fields from the serialized output", () => {
    const record = createTestSubagent({ invocation: { modelName: "haiku" }, toolCallId: "tc-1" });
    const result = toSubagentRecord(record);
    expect(result).not.toHaveProperty("notification");
    expect(result).not.toHaveProperty("execution");
    expect(result).not.toHaveProperty("invocation");
  });

  it("omits optional fields when undefined on the source", () => {
    const minimal = createTestSubagent({
      id: "min-1",
      description: "test",
      status: "running",
      result: undefined,
      toolUses: 0,
      startedAt: 500,
      completedAt: undefined,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    });
    const result = toSubagentRecord(minimal);
    expect(result).toEqual({
      id: "min-1",
      type: "general-purpose",
      description: "test",
      status: "running",
      toolUses: 0,
      startedAt: 500,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: 0,
    });
    expect(result).not.toHaveProperty("result");
    expect(result).not.toHaveProperty("error");
    expect(result).not.toHaveProperty("completedAt");
  });
});

/** Minimal SessionContext stub for service-adapter tests. */
function makeStubCtx(): SessionContext {
  return {
    cwd: "/tmp",
    model: undefined,
    modelRegistry: { find: () => undefined, getAll: () => [] },
    getSystemPrompt: () => "test prompt",
    sessionManager: {
      getSessionFile: () => undefined,
      getSessionId: () => "stub-session",
      getLeafId: () => "stub-leaf-entry",
      getBranch: () => [],
    },
  };
}

/**
 * Minimal ServiceRuntimeLike stub for tests.
 * Override `currentCtx` to simulate no active session.
 */
function makeRuntimeStub(override: Partial<ServiceRuntimeLike> = {}): ServiceRuntimeLike {
  return {
    currentCtx: makeStubCtx(),
    buildSnapshot: vi.fn((_: boolean): ParentSnapshot => STUB_SNAPSHOT),
    getServiceParentSessionInfo: vi.fn(() => Object.freeze({
      parentSessionFile: "/sessions/stub.jsonl",
      parentSessionId: "stub-session",
      parentEntryId: "stub-leaf-entry",
    })),
    ...override,
  };
}

/**
 * Stub `SubagentManagerLike` for adapter tests.
 *
 * Return type is unannotated so callers retain each stub's `Mock<...>` methods
 * (`mockReturnValue`, `mockImplementation`); configure per-test behavior on the
 * returned object's fields.
 */
function createActiveRuntime(ctx: SessionContext = makeStubCtx()): SubagentRuntime {
  const runtime = createSubagentRuntime();
  runtime.setSessionContext(ctx);
  return runtime;
}

function createManagerStub() {
  return {
    spawn: vi.fn<SubagentManagerLike["spawn"]>(() => "spawned-id"),
    getRecord: vi.fn<SubagentManagerLike["getRecord"]>(),
    listAgents: vi.fn<SubagentManagerLike["listAgents"]>(() => []),
    abort: vi.fn<SubagentManagerLike["abort"]>(() => true),
    hasRunning: vi.fn<SubagentManagerLike["hasRunning"]>(() => false),
    registerWorkspaceProvider: vi.fn<SubagentManagerLike["registerWorkspaceProvider"]>(() => () => {}),
    subscribeLifecycle: vi.fn<SubagentManagerLike["subscribeLifecycle"]>(() => () => {}),
    getLifecycleSnapshots: vi.fn<SubagentManagerLike["getLifecycleSnapshots"]>(() => []),
    getLifecycleSnapshotV2: vi.fn<SubagentManagerLike["getLifecycleSnapshotV2"]>(),
    appendControlResultV1: vi.fn<SubagentManagerLike["appendControlResultV1"]>(),
    registerChildExtensionV1: vi.fn<SubagentManagerLike["registerChildExtensionV1"]>(() => () => {}),
  };
}

describe("SubagentsServiceAdapter — getRecord and listAgents", () => {
  const recordA = createTestSubagent({
    id: "a-1",
    type: "Plan",
    description: "task A",
    lifetimeUsage: { input: 10, output: 20, cacheWrite: 5 },
  });

  const recordB = createTestSubagent({
    id: "b-2",
    type: "Plan",
    description: "task B",
    status: "running",
    toolUses: 1,
    startedAt: 3000,
    result: undefined,
    completedAt: undefined,
    lifetimeUsage: { input: 5, output: 10, cacheWrite: 0 },
  });

  function createService(records: Subagent[]): SubagentsService {
    const manager = createManagerStub();
    manager.getRecord.mockImplementation((id) => records.find((r) => r.id === id));
    manager.listAgents.mockImplementation(() => [...records].sort((a, b) => b.startedAt - a.startedAt));
    return new SubagentsServiceAdapter(
      manager,
      () => makeModel({ id: "test" }),
      makeRuntimeStub(),
    );
  }

  it("getRecord returns serialized record for known id", () => {
    const svc = createService([recordA, recordB]);
    const result = svc.getRecord("a-1");
    expect(result).toBeDefined();
    expect(result!.id).toBe("a-1");
    expect(result).not.toHaveProperty("session");
    expect(result).not.toHaveProperty("abortController");
  });

  it("getRecord returns undefined for unknown id", () => {
    const svc = createService([recordA]);
    expect(svc.getRecord("unknown")).toBeUndefined();
  });

  it("listAgents returns serialized records sorted by startedAt descending", () => {
    const svc = createService([recordA, recordB]);
    const list = svc.listAgents();
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe("b-2");
    expect(list[1].id).toBe("a-1");
    // Verify serialization
    expect(list[0]).not.toHaveProperty("session");
    expect(list[1]).not.toHaveProperty("abortController");
  });
});

describe("SubagentsServiceAdapter — spawn", () => {
  it("passes immutable source-backed session and leaf identity to manager.spawn", () => {
    const manager = createManagerStub();
    const runtime = createActiveRuntime({
      ...makeStubCtx(),
      sessionManager: {
        getSessionFile: () => "/sessions/parent.jsonl",
        getSessionId: () => "owner-session-id",
        getLeafId: () => "persisted-leaf-entry-id",
        getBranch: () => [],
      },
    });
    vi.spyOn(runtime, "buildSnapshot").mockReturnValue(STUB_SNAPSHOT);
    const svc = new SubagentsServiceAdapter(manager, vi.fn(), runtime);

    svc.spawn("Plan", "do something");

    const options = manager.spawn.mock.calls[0][3] as { parentSession?: unknown };
    expect(options.parentSession).toEqual({
      parentSessionFile: "/sessions/parent.jsonl",
      parentSessionId: "owner-session-id",
      parentEntryId: "persisted-leaf-entry-id",
    });
    expect(Object.isFrozen(options.parentSession)).toBe(true);
    expect(options.parentSession).not.toHaveProperty("toolCallId");
  });

  it("rejects without an active context before snapshot or manager mutation", () => {
    const manager = createManagerStub();
    const runtime = createSubagentRuntime();
    const buildSnapshot = vi.spyOn(runtime, "buildSnapshot").mockReturnValue(STUB_SNAPSHOT);
    const svc = new SubagentsServiceAdapter(manager, vi.fn(), runtime);

    expect(() => svc.spawn("Plan", "do something")).toThrow(
      "Cannot spawn a V2-tracked subagent without an active parent session.",
    );
    expect(buildSnapshot).not.toHaveBeenCalled();
    expect(manager.spawn).not.toHaveBeenCalled();
  });

  it("rejects without a session ID before snapshot or manager mutation", () => {
    const manager = createManagerStub();
    const runtime = createActiveRuntime({
      ...makeStubCtx(),
      sessionManager: {
        getSessionFile: () => "/sessions/parent.jsonl",
        getSessionId: () => "",
        getLeafId: () => "persisted-leaf-entry-id",
        getBranch: () => [],
      },
    });
    const buildSnapshot = vi.spyOn(runtime, "buildSnapshot").mockReturnValue(STUB_SNAPSHOT);
    const svc = new SubagentsServiceAdapter(manager, vi.fn(), runtime);

    expect(() => svc.spawn("Plan", "do something")).toThrow(
      "Cannot spawn a V2-tracked subagent without an active parent session.",
    );
    expect(buildSnapshot).not.toHaveBeenCalled();
    expect(manager.spawn).not.toHaveBeenCalled();
  });

  it("rejects without a persisted leaf before snapshot or manager mutation", () => {
    const manager = createManagerStub();
    const runtime = createActiveRuntime({
      ...makeStubCtx(),
      sessionManager: {
        getSessionFile: () => "/sessions/parent.jsonl",
        getSessionId: () => "owner-session-id",
        getLeafId: () => null,
        getBranch: () => [],
      },
    });
    const buildSnapshot = vi.spyOn(runtime, "buildSnapshot").mockReturnValue(STUB_SNAPSHOT);
    const svc = new SubagentsServiceAdapter(manager, vi.fn(), runtime);

    expect(() => svc.spawn("Plan", "do something")).toThrow(
      "Cannot spawn a V2-tracked subagent without a persisted parent session entry.",
    );
    expect(buildSnapshot).not.toHaveBeenCalled();
    expect(manager.spawn).not.toHaveBeenCalled();
  });

  it("resolves string model names via resolveModel", () => {
    const resolveModel = vi.fn(() => makeModel({ id: "claude-sonnet", provider: "anthropic" }));
    const registry = { find: () => undefined, getAll: () => [] };
    const svc = new SubagentsServiceAdapter(
      createManagerStub(),
      resolveModel,
      makeRuntimeStub({ currentCtx: { ...makeStubCtx(), modelRegistry: registry } }),
    );
    svc.spawn("Plan", "check TODOs", { model: "haiku" });
    expect(resolveModel).toHaveBeenCalledWith("haiku", registry);
  });

  it("throws on model resolution failure", () => {
    const svc = new SubagentsServiceAdapter(
      createManagerStub(),
      () => 'Model not found: "bad-model".\n\nAvailable models:\n  anthropic/claude-sonnet',
      makeRuntimeStub(),
    );
    expect(() => svc.spawn("Plan", "task", { model: "bad-model" })).toThrow(
      /Model not found/,
    );
  });

  it("delegates to manager.spawn with resolved model", () => {
    const resolvedModel = makeModel({ id: "claude-sonnet", provider: "anthropic" });
    const mgr = createManagerStub();
    const svc = new SubagentsServiceAdapter(
      mgr,
      () => resolvedModel,
      makeRuntimeStub(),
    );
    const id = svc.spawn("Plan", "check TODOs", { model: "sonnet", maxTurns: 5 });
    expect(id).toBe("spawned-id");
    expect(mgr.spawn).toHaveBeenCalledWith(
      expect.anything(), // snapshot
      "Plan",
      "check TODOs",
      expect.objectContaining({
        model: resolvedModel,
        maxTurns: 5,
      }),
    );
  });

  it("passes only background-capable options to manager.spawn", () => {
    const mgr = createManagerStub();
    const svc = new SubagentsServiceAdapter(mgr, vi.fn(), makeRuntimeStub());

    svc.spawn("Plan", "plan work", { bypassQueue: true });

    const options = mgr.spawn.mock.calls[0][3];
    expect(options).toEqual({
      description: "plan work",
      model: undefined,
      maxTurns: undefined,
      thinkingLevel: undefined,
      inheritContext: undefined,
      bypassQueue: true,
      parentSession: {
        parentSessionFile: "/sessions/stub.jsonl",
        parentSessionId: "stub-session",
        parentEntryId: "stub-leaf-entry",
      },
    });
  });

  it("uses truncated prompt as default description", () => {
    const mgr = createManagerStub();
    const svc = new SubagentsServiceAdapter(mgr, vi.fn(), makeRuntimeStub());
    const longPrompt = "x".repeat(200);
    svc.spawn("Plan", longPrompt);
    expect(mgr.spawn).toHaveBeenCalledWith(
      expect.anything(), // snapshot
      "Plan",
      longPrompt,
      expect.objectContaining({ description: "x".repeat(80) }),
    );
  });

  it("uses provided description over default", () => {
    const mgr = createManagerStub();
    const svc = new SubagentsServiceAdapter(mgr, vi.fn(), makeRuntimeStub());
    svc.spawn("Plan", "long prompt here", { description: "short desc" });
    expect(mgr.spawn).toHaveBeenCalledWith(
      expect.anything(), // snapshot
      "Plan",
      "long prompt here",
      expect.objectContaining({ description: "short desc" }),
    );
  });

  it("does not call resolveModel when no model option is provided", () => {
    const resolveModel = vi.fn();
    const svc = new SubagentsServiceAdapter(createManagerStub(), resolveModel, makeRuntimeStub());
    svc.spawn("Plan", "quick check");
    expect(resolveModel).not.toHaveBeenCalled();
  });
});

describe("SubagentsServiceAdapter — steer, abort, hasRunning", () => {
  function createSvc(mgr: ReturnType<typeof createManagerStub>) {
    return new SubagentsServiceAdapter(mgr, vi.fn(), makeRuntimeStub());
  }

  describe("abort", () => {
    it("delegates to manager.abort and returns its result", () => {
      const mgr = createManagerStub();
      const svc = createSvc(mgr);
      const result = svc.abort("agent-1");
      expect(mgr.abort).toHaveBeenCalledWith("agent-1");
      expect(result).toBe(true);
    });

    it("returns false when manager returns false", () => {
      const mgr = createManagerStub();
      mgr.abort.mockReturnValue(false);
      const svc = createSvc(mgr);
      expect(svc.abort("unknown")).toBe(false);
    });
  });


  describe("hasRunning", () => {
    it("delegates to manager.hasRunning", () => {
      const mgr = createManagerStub();
      mgr.hasRunning.mockReturnValue(true);
      const svc = createSvc(mgr);
      expect(svc.hasRunning()).toBe(true);
      expect(mgr.hasRunning).toHaveBeenCalled();
    });
  });

  describe("steer", () => {
    it("returns false for non-running agent", async () => {
      const mgr = createManagerStub();
      mgr.getRecord.mockReturnValue(createTestSubagent({ id: "a-1", status: "completed" }));
      const svc = createSvc(mgr);
      expect(await svc.steer("a-1", "hurry")).toBe(false);
    });

    it("returns false for unknown agent", async () => {
      const mgr = createManagerStub();
      mgr.getRecord.mockReturnValue(undefined);
      const svc = createSvc(mgr);
      expect(await svc.steer("unknown", "hurry")).toBe(false);
    });

    it("queues message and returns true when session not ready", async () => {
      const record = createTestSubagent({ id: "a-1", status: "running" });
      const mgr = createManagerStub();
      mgr.getRecord.mockReturnValue(record);
      const svc = createSvc(mgr);
      expect(await svc.steer("a-1", "do this")).toBe(true);
      expect(record.pendingSteerCount).toBe(1);
    });

    it("delegates to session.steer and returns true when session is ready", async () => {
      const mockSteer = vi.fn(async () => {});
      const record = createTestSubagent({ id: "a-1", status: "running" });
      record.subagentSession = toSubagentSession(createSubagentSessionStub(createMockSession({ steer: mockSteer })));
      const mgr = createManagerStub();
      mgr.getRecord.mockReturnValue(record);
      const svc = createSvc(mgr);
      expect(await svc.steer("a-1", "focus on tests")).toBe(true);
      expect(mockSteer).toHaveBeenCalledWith("focus on tests");
    });
  });
});

describe("SubagentsServiceAdapter — registerWorkspaceProvider", () => {
  it("delegates to manager.registerWorkspaceProvider and returns its disposer", () => {
    const disposer = vi.fn();
    const mgr = createManagerStub();
    mgr.registerWorkspaceProvider.mockReturnValue(disposer);
    const svc = new SubagentsServiceAdapter(mgr, vi.fn(), makeRuntimeStub());
    const provider: WorkspaceProvider = { prepare: vi.fn(async () => undefined) };

    const result = svc.registerWorkspaceProvider(provider);

    expect(mgr.registerWorkspaceProvider).toHaveBeenCalledWith(provider);
    expect(result).toBe(disposer);
  });
});

function makeLifecycleSnapshotV2(): LifecycleSnapshotV2ServiceResult {
  const snapshot: LifecycleSnapshotV2ServiceResult = {
    protocol: "mecha.children/v1",
    snapshot_id: "snapshot-1",
    owner_session_id: "owner-session",
    sequence: 3,
    runs: [],
  };
  Object.freeze(snapshot.runs);
  return Object.freeze(snapshot);
}

describe("SubagentsServiceAdapter — lifecycle", () => {
  it("delegates lifecycle subscriptions and returns the manager disposer", () => {
    const disposer = vi.fn();
    const listener = vi.fn();
    const mgr = createManagerStub();
    mgr.subscribeLifecycle.mockReturnValue(disposer);
    const svc = new SubagentsServiceAdapter(mgr, vi.fn(), makeRuntimeStub());

    const result = svc.subscribeLifecycle(listener);

    expect(mgr.subscribeLifecycle).toHaveBeenCalledExactlyOnceWith(listener);
    expect(result).toBe(disposer);
  });

  it("delegates an owner-scoped V2 snapshot without consulting or changing runtime state", () => {
    const snapshot = makeLifecycleSnapshotV2();
    const runtime = makeRuntimeStub();
    const mgr = createManagerStub();
    mgr.getLifecycleSnapshotV2.mockReturnValue(snapshot);
    const svc = new SubagentsServiceAdapter(mgr, vi.fn(), runtime);

    expect(svc.getLifecycleSnapshotV2("owner-session")).toBe(snapshot);
    expect(mgr.getLifecycleSnapshotV2).toHaveBeenCalledExactlyOnceWith("owner-session");
    expect(runtime.buildSnapshot).not.toHaveBeenCalled();
    expect(runtime.getServiceParentSessionInfo).not.toHaveBeenCalled();
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it("delegates a control result unchanged without resolving runtime or parent state", async () => {
    const runtime = makeRuntimeStub();
    const mgr = createManagerStub();
    const payload: ControlResultPayloadV1 = {
      protocol: "mecha.control/v1",
      result_id: "00000000-0000-4000-8000-000000000001",
      request_id: "00000000-0000-4000-8000-000000000002",
      target_session_epoch: 1,
      runtime_generation: "00000000-0000-4000-8000-000000000003",
      manifest_sha256: "a".repeat(64),
      status: "ok",
      content: "done",
      details: {},
    };
    const contextRef: ContextRefV1 = "ctx1_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
    mgr.appendControlResultV1.mockResolvedValue({ kind: "accepted", result_id: payload.result_id });
    const svc = new SubagentsServiceAdapter(mgr, vi.fn(), runtime);

    await expect(svc.appendControlResultV1(contextRef, payload)).resolves.toEqual({
      kind: "accepted",
      result_id: payload.result_id,
    });
    expect(mgr.appendControlResultV1).toHaveBeenCalledExactlyOnceWith(contextRef, payload);
    expect(runtime.buildSnapshot).not.toHaveBeenCalled();
    expect(runtime.getServiceParentSessionInfo).not.toHaveBeenCalled();
  });

  it("returns the manager's active lifecycle snapshots", () => {
    const snapshots = [
      Object.freeze({
        id: "agent-1",
        type: "Plan",
        description: "Check lifecycle",
        status: "running" as const,
      }),
    ];
    const mgr = createManagerStub();
    mgr.getLifecycleSnapshots.mockReturnValue(snapshots);
    const svc = new SubagentsServiceAdapter(mgr, vi.fn(), makeRuntimeStub());

    expect(svc.getLifecycleSnapshots()).toBe(snapshots);
    expect(mgr.getLifecycleSnapshots).toHaveBeenCalledOnce();
  });

  it("binds a child extension factory to the active service owner", () => {
    const mgr = createManagerStub();
    const disposer = vi.fn();
    mgr.registerChildExtensionV1.mockReturnValue(disposer);
    const svc = new SubagentsServiceAdapter(mgr, vi.fn(), makeRuntimeStub());
    const factory = vi.fn();

    expect(svc.registerChildExtensionV1({ name: "managed-child-tools", factory })).toBe(disposer);
    expect(mgr.registerChildExtensionV1).toHaveBeenCalledExactlyOnceWith(
      "stub-session",
      { name: "managed-child-tools", factory },
    );
  });

  it("rejects child extension registration without an active owner", () => {
    const runtime = makeRuntimeStub({ currentCtx: undefined });
    const mgr = createManagerStub();
    const svc = new SubagentsServiceAdapter(mgr, vi.fn(), runtime);

    expect(() => svc.registerChildExtensionV1({ name: "managed-child-tools", factory: vi.fn() })).toThrow(
      "Cannot register a child extension without an active owner session.",
    );
    expect(mgr.registerChildExtensionV1).not.toHaveBeenCalled();
  });
});
