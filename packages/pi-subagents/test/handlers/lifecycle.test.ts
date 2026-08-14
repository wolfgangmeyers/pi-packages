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
import type { SubagentsService } from "#src/service/service";

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
});

describe("SessionLifecycleHandler", () => {
  let runtime: LifecycleRuntime;
  let manager: LifecycleManager;
  let serviceRegistration: LifecycleServiceRegistration;
  let mockSetSessionContext: ReturnType<typeof vi.fn<LifecycleRuntime["setSessionContext"]>>;
  let mockClearSessionContext: ReturnType<typeof vi.fn<LifecycleRuntime["clearSessionContext"]>>;
  let mockClearCompleted: ReturnType<typeof vi.fn<LifecycleManager["clearCompleted"]>>;
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
    it("sets session context, publishes for its owner, and clears completed agents", () => {
      const ctx = makeContext("parent-session");

      handler.handleSessionStart({}, ctx);

      expect(runtime.setSessionContext).toHaveBeenCalledWith(ctx);
      expect(serviceRegistration.publish).toHaveBeenCalledWith("parent-session");
      expect(manager.clearCompleted).toHaveBeenCalled();
    });

    it("sets context and publishes before clearing completed", () => {
      const callOrder: string[] = [];
      mockSetSessionContext.mockImplementation(() => {
        callOrder.push("setSessionContext");
      });
      mockPublishService.mockImplementation(() => {
        callOrder.push("publishService");
      });
      mockClearCompleted.mockImplementation(() => {
        callOrder.push("clearCompleted");
      });

      handler.handleSessionStart({}, makeContext());

      expect(callOrder).toEqual(["setSessionContext", "publishService", "clearCompleted"]);
    });
  });

  describe("handleSessionBeforeSwitch", () => {
    it("clears completed agents", () => {
      handler.handleSessionBeforeSwitch();

      expect(manager.clearCompleted).toHaveBeenCalled();
    });
  });

  describe("handleSessionShutdown", () => {
    it("calls all cleanup steps", async () => {
      await handler.handleSessionShutdown();

      expect(mockUnpublishService).toHaveBeenCalled();
      expect(mockClearSessionContext).toHaveBeenCalled();
      expect(mockAbortAll).toHaveBeenCalled();
      expect(mockDisposeNotifications).toHaveBeenCalled();
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
      mockDispose.mockImplementation(() => {
        callOrder.push("dispose");
      });

      await handler.handleSessionShutdown();

      // Notifications are torn down before the aborts: a terminal transition
      // fires its nudge synchronously when no parent run is active, and Pi
      // cannot recall a message already handed to it.
      expect(callOrder).toEqual([
        "unpublishService",
        "clearSessionContext",
        "disposeNotifications",
        "abortAll",
        "dispose",
      ]);
    });
  });
});
