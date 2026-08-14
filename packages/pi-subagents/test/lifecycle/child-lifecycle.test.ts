import { describe, expect, it, vi } from "vitest";
import {
  type ChildLifecyclePublisher,
  createChildLifecyclePublisher,
  SUBAGENT_CHILD_COMPLETED,
  SUBAGENT_CHILD_DISPOSED,
  SUBAGENT_CHILD_SESSION_CREATED,
  SUBAGENT_CHILD_SPAWNING,
} from "#src/lifecycle/child-lifecycle";
import { unpublishCurrentSubagentsService } from "#src/service/owner-service-cleanup";
import {
  getSubagentsService,
  publishSubagentsService,
  type SubagentsService,
  subscribeSubagentsService,
} from "#src/service/service";

function setup(): {
  emit: ReturnType<typeof vi.fn>;
  publisher: ChildLifecyclePublisher;
} {
  const emit = vi.fn<(channel: string, data: unknown) => void>();
  const publisher = createChildLifecyclePublisher(emit);
  return { emit, publisher };
}

describe("createChildLifecyclePublisher", () => {
  it("emits subagents:child:spawning with the agent identity", () => {
    const { emit, publisher } = setup();

    publisher.spawning({ agentName: "Explore", parentSessionId: "parent-42" });

    expect(emit).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith(SUBAGENT_CHILD_SPAWNING, {
      agentName: "Explore",
      parentSessionId: "parent-42",
    });
  });

  it("emits subagents:child:session-created with the child session id", () => {
    const { emit, publisher } = setup();

    publisher.sessionCreated({
      sessionId: "child-session-abc",
      parentSessionId: "parent-42",
    });

    expect(emit).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith(SUBAGENT_CHILD_SESSION_CREATED, {
      sessionId: "child-session-abc",
      parentSessionId: "parent-42",
    });
  });

  it("emits subagents:child:completed with the run outcome", () => {
    const { emit, publisher } = setup();

    publisher.completed({
      sessionDir: "/sessions/child-abc",
      agentName: "Explore",
      aborted: false,
      steered: true,
    });

    expect(emit).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith(SUBAGENT_CHILD_COMPLETED, {
      sessionDir: "/sessions/child-abc",
      agentName: "Explore",
      aborted: false,
      steered: true,
    });
  });

  it("emits subagents:child:disposed with the child session id", () => {
    const { emit, publisher } = setup();

    publisher.disposed({ sessionId: "child-session-abc" });

    expect(emit).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith(SUBAGENT_CHILD_DISPOSED, {
      sessionId: "child-session-abc",
    });
  });

  it("unpublishes the child service and notifies subscribers on disposal", () => {
    const childService = makeService();
    const observed: Array<SubagentsService | undefined> = [];
    publishSubagentsService("child-session-abc", childService);
    const unsubscribe = subscribeSubagentsService(
      "child-session-abc",
      (service) => observed.push(service),
    );
    const publisher = createChildLifecyclePublisher(
      vi.fn(),
      ({ sessionId }) => unpublishCurrentSubagentsService(sessionId),
    );

    publisher.disposed({ sessionId: "child-session-abc" });

    expect(getSubagentsService("child-session-abc")).toBeUndefined();
    expect(observed).toEqual([childService, undefined]);
    unsubscribe();
  });

  it("treats cleanup for an unpublished child as a no-op", () => {
    expect(() =>
      unpublishCurrentSubagentsService("missing-child-session"),
    ).not.toThrow();
  });

  it("still cleans up the child service when disposed event delivery throws", () => {
    const childService = makeService();
    publishSubagentsService("child-session-abc", childService);
    const publisher = createChildLifecyclePublisher(
      () => {
        throw new Error("event delivery failed");
      },
      ({ sessionId }) => unpublishCurrentSubagentsService(sessionId),
    );

    expect(() =>
      publisher.disposed({ sessionId: "child-session-abc" }),
    ).toThrow("event delivery failed");
    expect(getSubagentsService("child-session-abc")).toBeUndefined();
  });

  it("passes an undefined parentSessionId through unchanged", () => {
    const { emit, publisher } = setup();

    publisher.spawning({ agentName: "general-purpose", parentSessionId: undefined });

    expect(emit).toHaveBeenCalledWith(SUBAGENT_CHILD_SPAWNING, {
      agentName: "general-purpose",
      parentSessionId: undefined,
    });
  });

  it("exposes the canonical channel-name strings", () => {
    expect(SUBAGENT_CHILD_SPAWNING).toBe("subagents:child:spawning");
    expect(SUBAGENT_CHILD_SESSION_CREATED).toBe("subagents:child:session-created");
    expect(SUBAGENT_CHILD_COMPLETED).toBe("subagents:child:completed");
    expect(SUBAGENT_CHILD_DISPOSED).toBe("subagents:child:disposed");
  });
});

function makeService(): SubagentsService {
  return {
    spawn: () => "agent-id",
    getRecord: () => undefined,
    listAgents: () => [],
    abort: () => false,
    steer: () => Promise.resolve(false),
    hasRunning: () => false,
    subscribeLifecycle: () => () => undefined,
    getLifecycleSnapshots: () => [],
    registerWorkspaceProvider: () => () => undefined,
  };
}
