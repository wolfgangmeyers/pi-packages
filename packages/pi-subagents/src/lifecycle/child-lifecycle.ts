/**
 * child-lifecycle.ts — Child-execution lifecycle event contract and publisher.
 *
 * The core publishes its child-execution lifecycle as ordered events on the Pi
 * event bus; reactive consumers (permissions, telemetry, UI) subscribe rather
 * than the core reaching out to them (ADR 0002). This module owns the channel
 * names, payload shapes, and the publisher that emits them.
 *
 * The publisher takes an injected `emit` callback so this module stays free of
 * Pi SDK imports — `index.ts` wires it to `pi.events.emit`.
 */

import { journalSubagentError, journalSubagentEvent } from "#src/observation/instrumentation";

/** Emitted at the start of a child run, before the session is created. */
export const SUBAGENT_CHILD_SPAWNING = "subagents:child:spawning";

/**
 * Emitted after the child session is created, immediately before
 * `bindExtensions()`. Carries the child session id consumers need to register
 * the session in `SubagentSessionRegistry`. Subscribers must register
 * synchronously so the entry lands before binding proceeds (see ADR 0002 /
 * the event-bus synchronous-dispatch guarantee).
 */
export const SUBAGENT_CHILD_SESSION_CREATED = "subagents:child:session-created";

/** Emitted after the child's prompt resolves (normal, steered, or aborted). */
export const SUBAGENT_CHILD_COMPLETED = "subagents:child:completed";

/** Emitted in the run's `finally` — always fires, on success and error. */
export const SUBAGENT_CHILD_DISPOSED = "subagents:child:disposed";

/** Payload for `subagents:child:spawning`. */
export interface ChildSpawningEvent {
  agentName: string;
  parentSessionId?: string;
}

/** Payload for `subagents:child:session-created`. */
export interface ChildSessionCreatedEvent {
  /** Child session id — the registry key. Unique per child; concurrent
   * siblings of the same parent occupy distinct keys. */
  sessionId: string;
  parentSessionId?: string;
}

/** Payload for `subagents:child:completed`. */
export interface ChildCompletedEvent {
  sessionDir: string;
  agentName: string;
  /** True if the run was hard-aborted (max turns + grace exceeded). */
  aborted: boolean;
  /** True if the run was steered to wrap up (soft turn limit) but finished. */
  steered: boolean;
}

/** Payload for `subagents:child:disposed`. */
export interface ChildDisposedEvent {
  /** Child session id — the registry key. Must match `session-created`. */
  sessionId: string;
}

/** Narrow emit seam — injected, never imports the Pi SDK. */
export type LifecycleEmit = (channel: string, data: unknown) => void;

/** Publishes the child-execution lifecycle on the event bus. */
export interface ChildLifecyclePublisher {
  spawning(event: ChildSpawningEvent): void;
  sessionCreated(event: ChildSessionCreatedEvent): void;
  completed(event: ChildCompletedEvent): void;
  disposed(event: ChildDisposedEvent): void;
}

/** Build a publisher backed by an injected `emit` callback. */
export function createChildLifecyclePublisher(
  emit: LifecycleEmit,
  onDisposed?: (event: ChildDisposedEvent) => void,
): ChildLifecyclePublisher {
  return {
    spawning(event) {
      emitChildEvent(SUBAGENT_CHILD_SPAWNING, event, "subagents.child.spawning", {
        kind: event.agentName,
        parent_session_id: event.parentSessionId,
      });
    },
    sessionCreated(event) {
      emitChildEvent(SUBAGENT_CHILD_SESSION_CREATED, event, "subagents.child.session_created", {
        session_id: event.sessionId,
        parent_session_id: event.parentSessionId,
      });
    },
    completed(event) {
      emitChildEvent(SUBAGENT_CHILD_COMPLETED, event, "subagents.child.completed", {
        kind: event.agentName,
        status: event.aborted ? "aborted" : event.steered ? "steered" : "completed",
      });
    },
    disposed(event) {
      try {
        emitChildEvent(SUBAGENT_CHILD_DISPOSED, event, "subagents.child.disposed", {
          session_id: event.sessionId,
        });
      } finally {
        onDisposed?.(event);
      }
    },
  };

  function emitChildEvent(
    channel: string,
    event: unknown,
    journalEvent: string,
    fields: Parameters<typeof journalSubagentEvent>[1],
  ): void {
    try {
      emit(channel, event);
    } catch (error) {
      journalSubagentError("child_lifecycle_emit", error, fields);
      throw error;
    }
    journalSubagentEvent(journalEvent, fields);
  }
}
