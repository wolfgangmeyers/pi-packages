import { afterEach, describe, expect, it, vi } from "vitest";
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
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
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

    publishSubagentsService("child-session", childService);
    publishSubagentsService("parent-session", originalParentService);
    publishSubagentsService("parent-session", replacementParentService);
    unpublishSubagentsService("parent-session", originalParentService);

    expect(observedParentSnapshots).toEqual([
      undefined,
      [],
      PARENT_LIFECYCLE_SNAPSHOTS,
    ]);
    expect(getSubagentsService("parent-session")).toBe(replacementParentService);

    unpublishSubagentsService("parent-session", replacementParentService);
    expect(observedParentSnapshots).toEqual([
      undefined,
      [],
      PARENT_LIFECYCLE_SNAPSHOTS,
      undefined,
    ]);
    expect(getSubagentsService("child-session")).toBe(childService);

    unsubscribe();
    unpublishSubagentsService("child-session", childService);
    expect((globalThis as Record<symbol, unknown>)[SERVICE_REGISTRY_KEY]).toBeUndefined();
  });

  it("does not notify when the same service object is republished", () => {
    const service = makeService();
    const observed: Array<SubagentsService | undefined> = [];
    subscribeSubagentsService("owner", (current) => observed.push(current));

    publishSubagentsService("owner", service);
    publishSubagentsService("owner", service);

    expect(observed).toEqual([undefined, service]);
  });

  it("treats duplicate listener functions as separate subscriptions", () => {
    const service = makeService();
    const observed: Array<SubagentsService | undefined> = [];
    const listener = (current: SubagentsService | undefined): void => {
      observed.push(current);
    };
    const unsubscribeFirst = subscribeSubagentsService("owner", listener);
    const unsubscribeSecond = subscribeSubagentsService("owner", listener);

    publishSubagentsService("owner", service);
    unsubscribeFirst();
    unpublishSubagentsService("owner", service);

    expect(observed).toEqual([undefined, undefined, service, service, undefined]);
    unsubscribeSecond();
    expect((globalThis as Record<symbol, unknown>)[SERVICE_REGISTRY_KEY]).toBeUndefined();
  });

  it("keeps a newer subscription when an old disposer runs again", () => {
    const service = makeService();
    const unsubscribeOld = subscribeSubagentsService(
      "owner",
      () => undefined,
    );
    unsubscribeOld();
    const observed: Array<SubagentsService | undefined> = [];
    subscribeSubagentsService("owner", (current) => observed.push(current));

    unsubscribeOld();
    publishSubagentsService("owner", service);

    expect(observed).toEqual([undefined, service]);
  });

  it("skips a subscription removed during the same notification pass", () => {
    const service = makeService();
    const secondObserved: Array<SubagentsService | undefined> = [];
    let unsubscribeSecond: () => void = () => undefined;
    subscribeSubagentsService("owner", (current) => {
      if (current === service) unsubscribeSecond();
    });
    unsubscribeSecond = subscribeSubagentsService("owner", (current) => {
      secondObserved.push(current);
    });

    publishSubagentsService("owner", service);

    expect(secondObserved).toEqual([undefined]);
  });

  it("does not deliver stale outer notifications after a reentrant replacement", () => {
    const originalService = makeService();
    const replacementService = makeService(PARENT_LIFECYCLE_SNAPSHOTS);
    const firstObserved: Array<SubagentsService | undefined> = [];
    const secondObserved: Array<SubagentsService | undefined> = [];

    subscribeSubagentsService("owner", (service) => {
      firstObserved.push(service);
      if (service === originalService) {
        publishSubagentsService("owner", replacementService);
      }
    });
    subscribeSubagentsService("owner", (service) => {
      secondObserved.push(service);
    });

    publishSubagentsService("owner", originalService);

    expect(firstObserved).toEqual([undefined, originalService, replacementService]);
    expect(secondObserved).toEqual([undefined, replacementService]);
    expect(getSubagentsService("owner")).toBe(replacementService);
  });

  it("isolates listener errors and reports them through debug logging", () => {
    vi.stubEnv("PI_SUBAGENTS_DEBUG", "1");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = new Error("listener failed");

    expect(() =>
      subscribeSubagentsService("owner", () => {
        throw error;
      }),
    ).not.toThrow();
    expect(() => publishSubagentsService("owner", makeService())).not.toThrow();

    expect(warn).toHaveBeenCalledWith(
      "[pi-subagents:debug] SubagentsService listener:",
      error,
    );
  });

  it("does not let a stale subscription disposer delete a newer registry", () => {
    const unsubscribeStale = subscribeSubagentsService(
      "stale-owner",
      () => undefined,
    );
    // Simulate a process-global registry replacement by a newer module instance.
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- deliberate stale-registry regression setup
    delete (globalThis as Record<symbol, unknown>)[SERVICE_REGISTRY_KEY];
    const currentService = makeService();
    publishSubagentsService("current-owner", currentService);

    unsubscribeStale();

    expect(getSubagentsService("current-owner")).toBe(currentService);
  });

  it("retains a subscribed parent and exactly 99 newest children at the cap", () => {
    const parentService = makeService(PARENT_LIFECYCLE_SNAPSHOTS);
    const childServices = Array.from({ length: 101 }, () => makeService());
    subscribeSubagentsService("parent-session", () => undefined);
    publishSubagentsService("parent-session", parentService);

    for (const [index, childService] of childServices.entries()) {
      publishSubagentsService(`child-session-${index}`, childService);
    }

    const registry = (globalThis as Record<symbol, unknown>)[
      SERVICE_REGISTRY_KEY
    ] as { services: Map<string, SubagentsService> };
    expect([...registry.services.keys()]).toEqual([
      "parent-session",
      ...Array.from({ length: 99 }, (_, index) => `child-session-${index + 2}`),
    ]);
    expect(registry.services.get("parent-session")).toBe(parentService);
    expect(registry.services.size).toBe(100);
  });

  it("rejects a new publication when all retained owners are subscribed", () => {
    const retainedServices = Array.from({ length: 100 }, () => makeService());
    for (const [index, service] of retainedServices.entries()) {
      const owner = `subscribed-owner-${index}`;
      subscribeSubagentsService(owner, () => undefined);
      publishSubagentsService(owner, service);
    }

    const replacement = makeService();
    expect(() =>
      publishSubagentsService("subscribed-owner-0", replacement),
    ).not.toThrow();
    expect(() =>
      publishSubagentsService("new-owner", makeService()),
    ).toThrow(
      "Cannot publish SubagentsService: all 100 retained owners have active subscribers",
    );

    const registry = (globalThis as Record<symbol, unknown>)[
      SERVICE_REGISTRY_KEY
    ] as { services: Map<string, SubagentsService> };
    expect([...registry.services.keys()]).toEqual([
      ...Array.from({ length: 99 }, (_, index) => `subscribed-owner-${index + 1}`),
      "subscribed-owner-0",
    ]);
    expect(registry.services.has("new-owner")).toBe(false);
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
