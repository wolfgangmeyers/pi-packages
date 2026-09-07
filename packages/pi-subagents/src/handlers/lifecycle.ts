import type { SessionShutdownEvent, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import type { LifecycleV2ReleaseDisposition } from "#src/lifecycle/subagent-manager";
import { type DisposedChildOwnerRelease, registerSubagentsServiceOwnerRelease } from "#src/service/owner-service-cleanup";
import type { SubagentsService } from "#src/service/service";
import type { SessionContext } from "#src/types";

/**
 * Session lifecycle event handlers: session_start, session_before_switch, session_shutdown.
 *
 * Extracted from index.ts so each handler can be tested in isolation
 * with mocked narrow interfaces.
 */

/** Narrow manager interface — only the methods lifecycle handlers call. */
export interface LifecycleManager {
  clearCompleted(): void;
  bindLifecycleV2Owner(ownerSessionId: string): void;
  releaseLifecycleV2Owner(ownerSessionId: string, disposition: LifecycleV2ReleaseDisposition): void;
  abortAll(): void;
  dispose(): void;
}

/** Narrow runtime interface — only the methods lifecycle handlers call. */
export interface LifecycleRuntime {
  setSessionContext(ctx: SessionContext): void;
  clearSessionContext(): void;
}

/** Owner-scoped service publication used by the session lifecycle handler. */
export interface LifecycleServiceRegistration {
  publish(ownerSessionId: string): void;
  unpublish(): void;
}

type OwnerReleaseRegistration = (
  service: SubagentsService,
  release: DisposedChildOwnerRelease,
) => () => void;

/** Publishes one extension instance's service under its current owning session. */
export class OwnerScopedServiceRegistration implements LifecycleServiceRegistration {
  private ownerSessionId: string | undefined;
  private unregisterOwnerRelease: (() => void) | undefined;

  constructor(
    private readonly service: SubagentsService,
    private readonly publishService: (ownerSessionId: string, service: SubagentsService) => void,
    private readonly unpublishService: (ownerSessionId: string, service: SubagentsService) => void,
    private readonly registerOwnerRelease: OwnerReleaseRegistration = registerSubagentsServiceOwnerRelease,
    private readonly releaseLifecycleV2Owner: (ownerSessionId: string, disposition: "disposed-child") => void = () => undefined,
    private readonly releaseChildExtensionFactoriesForOwner: (ownerSessionId: string) => void = () => undefined,
  ) {}

  publish(ownerSessionId: string): void {
    if (this.ownerSessionId && this.ownerSessionId !== ownerSessionId) this.unpublish();
    this.publishService(ownerSessionId, this.service);

    const previousUnregister = this.unregisterOwnerRelease;
    try {
      this.unregisterOwnerRelease = this.registerOwnerRelease(this.service, (disposition) => {
        this.releaseLifecycleV2Owner(ownerSessionId, disposition);
      });
      this.ownerSessionId = ownerSessionId;
      previousUnregister?.();
    } catch (error) {
      this.unpublishService(ownerSessionId, this.service);
      throw error;
    }
  }

  unpublish(): void {
    const ownerSessionId = this.ownerSessionId;
    if (!ownerSessionId) return;
    this.ownerSessionId = undefined;
    const unregisterOwnerRelease = this.unregisterOwnerRelease;
    this.unregisterOwnerRelease = undefined;
    try {
      unregisterOwnerRelease?.();
      this.releaseChildExtensionFactoriesForOwner(ownerSessionId);
    } finally {
      this.unpublishService(ownerSessionId, this.service);
    }
  }
}

/**
 * Handles session lifecycle events.
 *
 * Constructor deps:
 * - `runtime` — owns session context state
 * - `manager` — manages agent lifecycle (clear, abort, dispose)
 * - `disposeNotifications` — tears down the notification system on shutdown
 * - `serviceRegistration` — publishes and unpublishes this session's service
 */
export class SessionLifecycleHandler {
  private lifecycleOwnerSessionId: string | undefined;

  constructor(
    private readonly runtime: LifecycleRuntime,
    private readonly manager: LifecycleManager,
    private readonly disposeNotifications: () => void,
    private readonly serviceRegistration: LifecycleServiceRegistration,
  ) {}

  handleSessionStart(event: SessionStartEvent, ctx: unknown): void {
    const sessionContext = ctx as SessionContext;
    const ownerSessionId = sessionContext.sessionManager.getSessionId();
    this.manager.bindLifecycleV2Owner(ownerSessionId);
    try {
      this.runtime.setSessionContext(sessionContext);
      this.serviceRegistration.publish(ownerSessionId);
      this.lifecycleOwnerSessionId = ownerSessionId;
      this.manager.clearCompleted();
    } catch (error) {
      try {
        this.serviceRegistration.unpublish();
      } finally {
        try {
          this.runtime.clearSessionContext();
        } finally {
          this.manager.releaseLifecycleV2Owner(
            ownerSessionId,
            event.reason === "reload" ? "reload" : "quit",
          );
          this.lifecycleOwnerSessionId = undefined;
        }
      }
      throw error;
    }
  }

  handleSessionBeforeSwitch(): void {
    this.manager.clearCompleted();
  }

  // Cleanup order matters:
  // 1. Unpublish service — prevent new cross-extension calls
  // 2. Clear session context — no more session state
  // 3. Dispose notifications — silence nudges before aborts emit terminal updates
  // 4. Abort all agents — stops work before releasing its V2 owner claim
  // 5. Release the exact bound owner with Pi's actual shutdown reason
  // 6. Dispose manager — final cleanup
  handleSessionShutdown(event: SessionShutdownEvent): Promise<void> {
    const ownerSessionId = this.lifecycleOwnerSessionId;
    this.serviceRegistration.unpublish();
    this.runtime.clearSessionContext();
    this.disposeNotifications();
    this.manager.abortAll();
    this.lifecycleOwnerSessionId = undefined;
    try {
      if (ownerSessionId) this.manager.releaseLifecycleV2Owner(ownerSessionId, event.reason);
    } finally {
      this.manager.dispose();
    }
    return Promise.resolve();
  }
}
