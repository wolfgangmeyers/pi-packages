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

/** Publishes one extension instance's service under its current owning session. */
export class OwnerScopedServiceRegistration implements LifecycleServiceRegistration {
  private ownerSessionId: string | undefined;

  constructor(
    private readonly service: SubagentsService,
    private readonly publishService: (ownerSessionId: string, service: SubagentsService) => void,
    private readonly unpublishService: (ownerSessionId: string, service: SubagentsService) => void,
  ) {}

  publish(ownerSessionId: string): void {
    if (this.ownerSessionId && this.ownerSessionId !== ownerSessionId) {
      this.unpublishService(this.ownerSessionId, this.service);
    }
    this.publishService(ownerSessionId, this.service);
    this.ownerSessionId = ownerSessionId;
  }

  unpublish(): void {
    if (!this.ownerSessionId) return;
    this.unpublishService(this.ownerSessionId, this.service);
    this.ownerSessionId = undefined;
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
  constructor(
    private readonly runtime: LifecycleRuntime,
    private readonly manager: LifecycleManager,
    private readonly disposeNotifications: () => void,
    private readonly serviceRegistration: LifecycleServiceRegistration,
  ) {}

  handleSessionStart(_event: unknown, ctx: unknown): void {
    const sessionContext = ctx as SessionContext;
    this.runtime.setSessionContext(sessionContext);
    this.serviceRegistration.publish(sessionContext.sessionManager.getSessionId());
    this.manager.clearCompleted();
  }

  handleSessionBeforeSwitch(): void {
    this.manager.clearCompleted();
  }

  // Cleanup order matters:
  // 1. Unpublish service — prevent new cross-extension calls
  // 2. Clear session context — no more session state
  // 3. Dispose notifications — silence nudges *before* the aborts that would
  //    raise them: no parent run is active at shutdown, so a terminal
  //    transition delivers its nudge synchronously and Pi cannot recall it
  // 4. Abort all agents — stop running and queued work
  // 5. Dispose manager — final cleanup
  handleSessionShutdown(): Promise<void> {
    this.serviceRegistration.unpublish();
    this.runtime.clearSessionContext();
    this.disposeNotifications();
    this.manager.abortAll();
    this.manager.dispose();
    return Promise.resolve();
  }
}
