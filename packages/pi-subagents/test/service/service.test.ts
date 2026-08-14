import { afterEach, describe, expect, it } from "vitest";
import {
  getSubagentsService,
  publishSubagentsService,
  type SpawnOptions,
  SUBAGENT_EVENTS,
  type SubagentLifecycleSnapshot,
  type SubagentsService,
  subscribeSubagentsService,
  unpublishSubagentsService,
} from "#src/service/service";

const SERVICE_REGISTRY_KEY = Symbol.for("@gotgenes/pi-subagents:service-registry");

const PARENT_LIFECYCLE_SNAPSHOTS: readonly SubagentLifecycleSnapshot[] = [
  { id: "completed-1", type: "Explore", description: "completed one", status: "completed" },
  { id: "completed-2", type: "Explore", description: "completed two", status: "completed" },
  { id: "completed-3", type: "Explore", description: "completed three", status: "completed" },
  { id: "running-1", type: "Explore", description: "running one", status: "running" },
  { id: "running-2", type: "Explore", description: "running two", status: "running" },
  { id: "running-3", type: "Explore", description: "running three", status: "running" },
  { id: "running-4", type: "Explore", description: "running four", status: "running" },
];

function makeService(
  lifecycleSnapshots: readonly SubagentLifecycleSnapshot[] = [],
): SubagentsService {
  return {
    spawn: () => "agent-id",
    getRecord: () => undefined,
    listAgents: () => [],
    abort: () => false,
    steer: () => Promise.resolve(false),
    hasRunning: () => false,
    subscribeLifecycle: () => () => undefined,
    getLifecycleSnapshots: () => lifecycleSnapshots,
    registerWorkspaceProvider: () => () => undefined,
  };
}

describe("owner-scoped SubagentsService registry", () => {
  afterEach(() => {
    // Tests deliberately inspect and reset the process-global cross-extension channel.
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- required to isolate the Symbol-keyed registry
    delete (globalThis as Record<symbol, unknown>)[SERVICE_REGISTRY_KEY];
  });

  it("keeps parent and child services under separate session owners", () => {
    const parentService = makeService(PARENT_LIFECYCLE_SNAPSHOTS);
    const childService = makeService();

    publishSubagentsService("parent-session", parentService);
    publishSubagentsService("child-session", childService);

    expect({
      parent: getSubagentsService("parent-session"),
      child: getSubagentsService("child-session"),
    }).toEqual({ parent: parentService, child: childService });
    expect(getSubagentsService("parent-session")?.getLifecycleSnapshots()).toEqual(
      PARENT_LIFECYCLE_SNAPSHOTS,
    );
  });

  it("notifies only the replaced owner and ignores stale cleanup", () => {
    const originalParentService = makeService();
    const replacementParentService = makeService(PARENT_LIFECYCLE_SNAPSHOTS);
    const childService = makeService();
    const observedParentSnapshots: Array<readonly SubagentLifecycleSnapshot[] | undefined> = [];
    const unsubscribe = subscribeSubagentsService("parent-session", (service) => {
      observedParentSnapshots.push(service?.getLifecycleSnapshots());
    });

    publishSubagentsService("original-child-session", childService);
    expect(observedParentSnapshots).toEqual([undefined]);

    publishSubagentsService("parent-session", originalParentService);
    expect(observedParentSnapshots).toEqual([undefined, []]);

    publishSubagentsService("replacement-child-session", makeService());
    expect(observedParentSnapshots).toEqual([undefined, []]);

    publishSubagentsService("parent-session", replacementParentService);
    expect(observedParentSnapshots).toEqual([
      undefined,
      [],
      PARENT_LIFECYCLE_SNAPSHOTS,
    ]);

    const serviceSeenByNextHeartbeat = getSubagentsService("parent-session");
    unpublishSubagentsService("parent-session", originalParentService);
    publishSubagentsService("parent-session", replacementParentService);
    expect({
      serviceSeenByNextHeartbeat,
      service: getSubagentsService("parent-session"),
      snapshots: observedParentSnapshots,
    }).toEqual({
      serviceSeenByNextHeartbeat: replacementParentService,
      service: replacementParentService,
      snapshots: [undefined, [], PARENT_LIFECYCLE_SNAPSHOTS],
    });

    unpublishSubagentsService("parent-session", replacementParentService);
    expect({
      observedParentSnapshots,
      retainedChild: getSubagentsService("original-child-session"),
      registryExists: (globalThis as Record<symbol, unknown>)[SERVICE_REGISTRY_KEY] !== undefined,
    }).toEqual({
      observedParentSnapshots: [undefined, [], PARENT_LIFECYCLE_SNAPSHOTS, undefined],
      retainedChild: childService,
      registryExists: true,
    });

    unsubscribe();
    unpublishSubagentsService("original-child-session", childService);
    const replacementChildService = getSubagentsService("replacement-child-session");
    if (replacementChildService) {
      unpublishSubagentsService("replacement-child-session", replacementChildService);
    }
    expect((globalThis as Record<symbol, unknown>)[SERVICE_REGISTRY_KEY]).toBeUndefined();
  });

  it("bounds retained services while a parent heartbeat keeps its replacement current", () => {
    const parentService = makeService(PARENT_LIFECYCLE_SNAPSHOTS);
    const childServices = Array.from({ length: 101 }, () => makeService());

    publishSubagentsService("parent-session", parentService);
    for (const [index, childService] of childServices.slice(0, 99).entries()) {
      publishSubagentsService(`child-session-${index}`, childService);
    }
    expect(getSubagentsService("parent-session")).toBe(parentService);
    publishSubagentsService("child-session-99", childServices[99]);
    publishSubagentsService("child-session-100", childServices[100]);

    expect({
      evicted: getSubagentsService("child-session-0"),
      parentSnapshots: getSubagentsService("parent-session")?.getLifecycleSnapshots(),
      latestChild: getSubagentsService("child-session-100"),
    }).toEqual({
      evicted: undefined,
      parentSnapshots: PARENT_LIFECYCLE_SNAPSHOTS,
      latestChild: childServices[100],
    });

    unpublishSubagentsService("parent-session", parentService);
    for (const [index, childService] of childServices.entries()) {
      unpublishSubagentsService(`child-session-${index}`, childService);
    }
    expect((globalThis as Record<symbol, unknown>)[SERVICE_REGISTRY_KEY]).toBeUndefined();
  });
});

describe("SubagentsService public contract", () => {
  it("has no foreground or wait spawn options and no waitForAll method", () => {
    type HasForegroundOption = "foreground" extends keyof SpawnOptions ? true : false;
    type HasWaitOption = "wait" extends keyof SpawnOptions ? true : false;
    type HasWaitForAll = "waitForAll" extends keyof SubagentsService ? true : false;
    const hasForegroundOption: HasForegroundOption = false;
    const hasWaitOption: HasWaitOption = false;
    const hasWaitForAll: HasWaitForAll = false;

    expect({ hasForegroundOption, hasWaitOption, hasWaitForAll }).toEqual({
      hasForegroundOption: false,
      hasWaitOption: false,
      hasWaitForAll: false,
    });
  });
});

describe("SUBAGENT_EVENTS", () => {
  it("exports expected event channel constants", () => {
    expect(SUBAGENT_EVENTS.STARTED).toBe("subagents:started");
    expect(SUBAGENT_EVENTS.COMPLETED).toBe("subagents:completed");
    expect(SUBAGENT_EVENTS.FAILED).toBe("subagents:failed");
    expect(SUBAGENT_EVENTS.RESUMED).toBe("subagents:resumed");
    expect(SUBAGENT_EVENTS.COMPACTED).toBe("subagents:compacted");
    expect(SUBAGENT_EVENTS.CREATED).toBe("subagents:created");
    expect(SUBAGENT_EVENTS.STEERED).toBe("subagents:steered");
  });

  it("does not declare a vacant activity channel", () => {
    expect("ACTIVITY" in SUBAGENT_EVENTS).toBe(false);
  });
});
