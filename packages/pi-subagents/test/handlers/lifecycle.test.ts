import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LifecycleManager,
  LifecycleRuntime,
  LifecycleServiceRegistration,
} from "#src/handlers/lifecycle";
import {
  OwnerScopedServiceRegistration,
  SessionLifecycleHandler,
} from "#src/handlers/lifecycle";
import {
  getSubagentsService,
  publishSubagentsService,
  type SubagentsService,
  unpublishSubagentsService,
} from "#src/service/service";

function makeContext(sessionId = "owner-session") {
  return {
    cwd: "/some/path",
    model: undefined,
    modelRegistry: {},
    getSystemPrompt: () => "",
    sessionManager: {
      getSessionFile: () => undefined,
      getSessionId: () => sessionId,
      getBranch: () => [],
    },
  };
}

describe("OwnerScopedServiceRegistration", () => {
  it("moves one extension service between session owners and cleans up by identity", () => {
    const service = {} as SubagentsService;
    const publish = vi.fn();
    const unpublish = vi.fn();
    const registration = new OwnerScopedServiceRegistration(service, publish, unpublish);

    registration.publish("parent-session");
    registration.publish("child-session");
    registration.unpublish();
    registration.unpublish();

    expect({ publish: publish.mock.calls, unpublish: unpublish.mock.calls }).toEqual({
      publish: [
        ["parent-session", service],
        ["child-session", service],
      ],
      unpublish: [
        ["parent-session", service],
        ["child-session", service],
      ],
    });
  });

  it("registers the active service identity to release its child owner", () => {
    const service = {} as SubagentsService;
    const publish = vi.fn();
    const unpublish = vi.fn();
    const unregister = vi.fn();
    const invokeRegisteredRelease = vi.fn<(reason: "disposed-child") => void>();
    const registerOwnerRelease = vi.fn((_service: SubagentsService, release: (reason: "disposed-child") => void) => {
      invokeRegisteredRelease.mockImplementation(release);
      return () => {
        unregister();
      };
    });
    const releaseLifecycleV2Owner = vi.fn();
    const registration = new OwnerScopedServiceRegistration(
      service,
      publish,
      unpublish,
      registerOwnerRelease,
      releaseLifecycleV2Owner,
    );

    registration.publish("child-session");
    invokeRegisteredRelease("disposed-child");
    registration.unpublish();

    expect(registerOwnerRelease).toHaveBeenCalledExactlyOnceWith(service, expect.any(Function));
    expect(releaseLifecycleV2Owner).toHaveBeenCalledExactlyOnceWith("child-session", "disposed-child");
    expect(unregister).toHaveBeenCalledExactlyOnceWith();
  });

  it("session shutdown removes only its owner's real registry entry", async () => {
    const parentService = makeService();
    const childService = makeService();
    const parentHandler = makeLifecycleHandler(parentService);
    const childHandler = makeLifecycleHandler(childService);

    parentHandler.handleSessionStart({ type: "session_start", reason: "startup" }, makeContext("parent-session"));
    childHandler.handleSessionStart({ type: "session_start", reason: "startup" }, makeContext("child-session"));
    await parentHandler.handleSessionShutdown({ type: "session_shutdown", reason: "quit" });

    expect({
      parent: getSubagentsService("parent-session"),
      child: getSubagentsService("child-session"),
    }).toEqual({ parent: undefined, child: childService });

    await childHandler.handleSessionShutdown({ type: "session_shutdown", reason: "quit" });
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
    getLifecycleSnapshotV2: () => ({
      protocol: "mecha.children/v1",
      snapshot_id: "snapshot-1",
      owner_session_id: "owner-session",
      sequence: 0,
      runs: [],
    }),
    appendControlResultV1: async (_contextRef, payload) => ({ kind: "accepted", result_id: payload.result_id }),
    registerChildExtensionV1: () => () => undefined,
    registerWorkspaceProvider: () => () => undefined,
  };
}

function makeLifecycleHandler(service: SubagentsService): SessionLifecycleHandler {
  return new SessionLifecycleHandler(
    { setSessionContext: () => undefined, clearSessionContext: () => undefined },
    {
      clearCompleted: () => undefined,
      bindLifecycleV2Owner: () => undefined,
      releaseLifecycleV2Owner: () => undefined,
      abortAll: () => undefined,
      dispose: () => undefined,
    },
    () => undefined,
    new OwnerScopedServiceRegistration(
      service,
      publishSubagentsService,
      unpublishSubagentsService,
    ),
  );
}

describe("SessionLifecycleHandler", () => {
  let runtime: LifecycleRuntime;
  let manager: LifecycleManager;
  let serviceRegistration: LifecycleServiceRegistration;
  let mockSetSessionContext: ReturnType<typeof vi.fn<LifecycleRuntime["setSessionContext"]>>;
  let mockClearSessionContext: ReturnType<typeof vi.fn<LifecycleRuntime["clearSessionContext"]>>;
  let mockClearCompleted: ReturnType<typeof vi.fn<LifecycleManager["clearCompleted"]>>;
  let mockBindLifecycleV2Owner: ReturnType<typeof vi.fn<(ownerSessionId: string) => void>>;
  let mockReleaseLifecycleV2Owner: ReturnType<typeof vi.fn<(ownerSessionId: string, reason: string) => void>>;
  let mockAbortAll: ReturnType<typeof vi.fn<LifecycleManager["abortAll"]>>;
  let mockDispose: ReturnType<typeof vi.fn<LifecycleManager["dispose"]>>;
  let mockDisposeNotifications: ReturnType<typeof vi.fn<() => void>>;
  let mockPublishService: ReturnType<typeof vi.fn<LifecycleServiceRegistration["publish"]>>;
  let mockUnpublishService: ReturnType<typeof vi.fn<LifecycleServiceRegistration["unpublish"]>>;
  let handler: SessionLifecycleHandler;

  beforeEach(() => {
    mockSetSessionContext = vi.fn();
    mockClearSessionContext = vi.fn();
    mockClearCompleted = vi.fn();
    mockBindLifecycleV2Owner = vi.fn();
    mockReleaseLifecycleV2Owner = vi.fn();
    mockAbortAll = vi.fn();
    mockDispose = vi.fn();
    mockDisposeNotifications = vi.fn();
    mockPublishService = vi.fn();
    mockUnpublishService = vi.fn();

    runtime = {
      setSessionContext: mockSetSessionContext,
      clearSessionContext: mockClearSessionContext,
    };
    manager = {
      clearCompleted: mockClearCompleted,
      bindLifecycleV2Owner: mockBindLifecycleV2Owner,
      releaseLifecycleV2Owner: mockReleaseLifecycleV2Owner,
      abortAll: mockAbortAll,
      dispose: mockDispose,
    };
    serviceRegistration = {
      publish: mockPublishService,
      unpublish: mockUnpublishService,
    };

    handler = new SessionLifecycleHandler(
      runtime,
      manager,
      mockDisposeNotifications,
      serviceRegistration,
    );
  });

  describe("handleSessionStart", () => {
    it("binds its owner before setting context, publishing, and clearing completed agents", () => {
      const ctx = makeContext("parent-session");

      handler.handleSessionStart({ type: "session_start", reason: "startup" }, ctx);

      expect(manager.bindLifecycleV2Owner).toHaveBeenCalledExactlyOnceWith("parent-session");
      expect(runtime.setSessionContext).toHaveBeenCalledWith(ctx);
      expect(serviceRegistration.publish).toHaveBeenCalledWith("parent-session");
      expect(manager.clearCompleted).toHaveBeenCalled();
    });

    it("binds, sets context, publishes, and clears completed in order", () => {
      const callOrder: string[] = [];
      mockBindLifecycleV2Owner.mockImplementation(() => {
        callOrder.push("bindLifecycleV2Owner");
      });
      mockSetSessionContext.mockImplementation(() => {
        callOrder.push("setSessionContext");
      });
      mockPublishService.mockImplementation(() => {
        callOrder.push("publishService");
      });
      mockClearCompleted.mockImplementation(() => {
        callOrder.push("clearCompleted");
      });

      handler.handleSessionStart({ type: "session_start", reason: "startup" }, makeContext());

      expect(callOrder).toEqual(["bindLifecycleV2Owner", "setSessionContext", "publishService", "clearCompleted"]);
    });

    it("rolls back a partial start and preserves sequence only for a reload start", () => {
      const callOrder: string[] = [];
      mockBindLifecycleV2Owner.mockImplementation(() => callOrder.push("bind"));
      mockSetSessionContext.mockImplementation(() => callOrder.push("setContext"));
      mockPublishService.mockImplementation(() => callOrder.push("publish"));
      mockClearCompleted.mockImplementation(() => {
        callOrder.push("clearCompleted");
        throw new Error("clear completed failed");
      });
      mockUnpublishService.mockImplementation(() => callOrder.push("unpublish"));
      mockClearSessionContext.mockImplementation(() => callOrder.push("clearContext"));
      mockReleaseLifecycleV2Owner.mockImplementation(() => callOrder.push("release"));

      expect(() => handler.handleSessionStart({ type: "session_start", reason: "reload" }, makeContext())).toThrow(
        "clear completed failed",
      );

      expect(callOrder).toEqual([
        "bind",
        "setContext",
        "publish",
        "clearCompleted",
        "unpublish",
        "clearContext",
        "release",
      ]);
      expect(mockReleaseLifecycleV2Owner).toHaveBeenCalledExactlyOnceWith("owner-session", "reload");
    });
  });

  describe("handleSessionBeforeSwitch", () => {
    it("clears completed agents", () => {
      handler.handleSessionBeforeSwitch();

      expect(manager.clearCompleted).toHaveBeenCalled();
    });
  });

  describe("handleSessionShutdown", () => {
    it("passes every SDK shutdown reason through unchanged", async () => {
      for (const reason of ["quit", "reload", "new", "resume", "fork"] as const) {
        handler.handleSessionStart({ type: "session_start", reason: "startup" }, makeContext(`owner-${reason}`));
        await handler.handleSessionShutdown({ type: "session_shutdown", reason });
      }

      expect(mockReleaseLifecycleV2Owner.mock.calls).toEqual([
        ["owner-quit", "quit"],
        ["owner-reload", "reload"],
        ["owner-new", "new"],
        ["owner-resume", "resume"],
        ["owner-fork", "fork"],
      ]);
    });

    it("calls all cleanup steps", async () => {
      handler.handleSessionStart({ type: "session_start", reason: "startup" }, makeContext());
      await handler.handleSessionShutdown({ type: "session_shutdown", reason: "quit" });

      expect(mockUnpublishService).toHaveBeenCalled();
      expect(mockClearSessionContext).toHaveBeenCalled();
      expect(mockAbortAll).toHaveBeenCalled();
      expect(mockDisposeNotifications).toHaveBeenCalled();
      expect(mockReleaseLifecycleV2Owner).toHaveBeenCalledExactlyOnceWith("owner-session", "quit");
      expect(mockDispose).toHaveBeenCalled();
    });

    it("calls cleanup in correct order", async () => {
      const callOrder: string[] = [];
      mockUnpublishService.mockImplementation(() => {
        callOrder.push("unpublishService");
      });
      mockClearSessionContext.mockImplementation(() => {
        callOrder.push("clearSessionContext");
      });
      mockAbortAll.mockImplementation(() => {
        callOrder.push("abortAll");
      });
      mockDisposeNotifications.mockImplementation(() => {
        callOrder.push("disposeNotifications");
      });
      mockReleaseLifecycleV2Owner.mockImplementation(() => {
        callOrder.push("releaseLifecycleV2Owner");
      });
      mockDispose.mockImplementation(() => {
        callOrder.push("dispose");
      });

      handler.handleSessionStart({ type: "session_start", reason: "startup" }, makeContext());
      callOrder.length = 0;
      await handler.handleSessionShutdown({ type: "session_shutdown", reason: "quit" });

      expect(callOrder).toEqual([
        "unpublishService",
        "clearSessionContext",
        "disposeNotifications",
        "abortAll",
        "releaseLifecycleV2Owner",
        "dispose",
      ]);
    });
  });
});
