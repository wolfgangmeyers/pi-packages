import { afterEach, describe, expect, it, vi } from "vitest";
import { ConcurrencyLimiter } from "#src/lifecycle/concurrency-limiter";
import type { CreateSubagentSessionParams } from "#src/lifecycle/create-subagent-session";
import { SubagentManager } from "#src/lifecycle/subagent-manager";
import { STUB_SNAPSHOT } from "#test/helpers/stub-ctx";
import { createSubagentSessionStub, toSubagentSession } from "#test/helpers/mock-session";

function createManager() {
  const createSubagentSession = vi.fn(async (_params: CreateSubagentSessionParams) =>
    toSubagentSession(createSubagentSessionStub()),
  );
  const manager = new SubagentManager({
    createSubagentSession,
    limiter: new ConcurrencyLimiter(() => 4),
    baseCwd: "/repo",
  });
  return { manager, createSubagentSession };
}

function spawnForOwner(manager: SubagentManager, ownerSessionId: string): string {
  return manager.spawn(STUB_SNAPSHOT, "general-purpose", "child work", {
    description: "child work",
    parentSession: { parentSessionId: ownerSessionId, parentEntryId: "parent-entry" },
    bypassQueue: true,
  });
}

describe("SubagentManager child extension factories", () => {
  const managers: SubagentManager[] = [];

  afterEach(() => {
    for (const manager of managers.splice(0)) manager.dispose();
  });

  it("snapshots one owner-bound public factory for a child before later disposal", async () => {
    const { manager, createSubagentSession } = createManager();
    managers.push(manager);
    const factory = vi.fn();
    const dispose = manager.registerChildExtensionV1("parent-session", {
      name: "managed-child-tools",
      factory,
    });

    const first = spawnForOwner(manager, "parent-session");
    await manager.getRecord(first)!.promise;
    expect(createSubagentSession.mock.calls[0]?.[0]).toMatchObject({
      childExtensionFactories: [{ name: "managed-child-tools", factory }],
    });

    dispose();
    const second = spawnForOwner(manager, "parent-session");
    await manager.getRecord(second)!.promise;
    expect(createSubagentSession.mock.calls[1]?.[0]).toMatchObject({
      childExtensionFactories: [],
    });
  });

  it("rejects collisions without replacing the original and clears registrations on owner release", async () => {
    const { manager, createSubagentSession } = createManager();
    managers.push(manager);
    const original = vi.fn();
    const replacement = vi.fn();
    manager.registerChildExtensionV1("parent-session", { name: "managed-child-tools", factory: original });

    expect(() => manager.registerChildExtensionV1("parent-session", {
      name: "managed-child-tools",
      factory: replacement,
    })).toThrow("Child extension factory name is already registered");

    manager.releaseLifecycleV2Owner("parent-session", "quit");
    const id = spawnForOwner(manager, "parent-session");
    await manager.getRecord(id)!.promise;
    expect(createSubagentSession.mock.calls[0]?.[0]).toMatchObject({ childExtensionFactories: [] });
  });
});
