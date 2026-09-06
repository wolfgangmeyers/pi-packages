/**
 * runtime.ts — SubagentRuntime: composition root for all mutable extension state.
 *
 * Eliminates module-scope state in agent-runner.ts and closure-scoped state
 * in index.ts by consolidating them into a single, testable object.
 * Follows the same pattern as pi-permission-system's ExtensionRuntime.
 */

import { buildParentSnapshot, type ParentSnapshot } from "#src/lifecycle/parent-snapshot";
import type { ModelInfo } from "#src/tools/spawn-config";
import type { ParentSessionInfo, SessionContext } from "#src/types";

/**
 * Narrow config subset read by Agent when driving the turn loop (defaultMaxTurns, graceTurns).
 * Kept separate so callers can satisfy it without depending on the full runtime.
 */
export interface RunConfig {
  readonly defaultMaxTurns: number | undefined;
  readonly graceTurns: number;
}

/**
 * All mutable state owned by the pi-subagents extension.
 *
 * Created once inside `piSubagentsExtension()` via `createSubagentRuntime()`.
 * Tests construct a fresh runtime per test for full isolation.
 */
export class SubagentRuntime {
  // ── Session state (was closure-scoped in index.ts) ───────────────────────
  /** Active Pi session context — set on session_start, cleared on session_shutdown. */
  currentCtx: SessionContext | undefined = undefined;

  // ── Session-context methods ──────────────────────────────────────────────

  /** Store the active Pi session context (called from session_start). */
  setSessionContext(ctx: SessionContext): void {
    this.currentCtx = ctx;
  }

  /** Clear the session context (called from session_shutdown). */
  clearSessionContext(): void {
    this.currentCtx = undefined;
  }

  /**
   * Build a parent snapshot from the current session context.
   * Only valid during an active session (currentCtx is defined).
   */
  buildSnapshot(inheritContext: boolean): ParentSnapshot {

    return buildParentSnapshot(this.currentCtx!, inheritContext);
  }

  /** Extract model info from the current session context. */
  getModelInfo(): ModelInfo {
    return {
      parentModel: this.currentCtx?.model,
      modelRegistry: this.currentCtx?.modelRegistry,
    };
  }

  /** Extract session identity from the current session context. */
  getSessionInfo(): { parentSessionFile: string; parentSessionId: string } {
    return {
      parentSessionFile: this.currentCtx?.sessionManager.getSessionFile() ?? "",
      parentSessionId: this.currentCtx?.sessionManager.getSessionId() ?? "",
    };
  }

  /**
   * Bind a direct service spawn to the active persisted session leaf.
   * Service callers have no tool call to correlate, so the leaf is the authoritative parent entry.
   */
  getServiceParentSessionInfo(): ParentSessionInfo {
    const sessionManager = this.currentCtx?.sessionManager;
    if (!sessionManager) {
      throw new Error("Cannot spawn a V2-tracked subagent without an active parent session.");
    }

    const parentSessionId = sessionManager.getSessionId();
    if (!isNonEmptyString(parentSessionId)) {
      throw new Error("Cannot spawn a V2-tracked subagent without an active parent session.");
    }
    if (typeof sessionManager.getLeafId !== "function") {
      throw new Error("Cannot spawn a V2-tracked subagent without a persisted parent session entry.");
    }

    const parentEntryId = sessionManager.getLeafId();
    if (!isNonEmptyString(parentEntryId)) {
      throw new Error("Cannot spawn a V2-tracked subagent without a persisted parent session entry.");
    }

    const sessionFile = sessionManager.getSessionFile();
    return Object.freeze({
      parentSessionFile: typeof sessionFile === "string" ? sessionFile : "",
      parentSessionId,
      parentEntryId,
    });
  }

  /**
   * Bind a new tool spawn to the persisted assistant entry that contains its exact tool call.
   * The tool-call ID remains notification correlation only; it is never used as an entry ID.
   */
  getToolParentSessionInfo(toolCallId: string): ParentSessionInfo {
    const sessionManager = this.currentCtx?.sessionManager;
    if (!sessionManager) {
      throw new Error("Cannot spawn a subagent without an active parent session.");
    }
    if (
      typeof sessionManager.getLeafEntry !== "function" ||
      typeof sessionManager.getEntry !== "function"
    ) {
      throw new Error("Cannot spawn a subagent because the active session cannot read persisted entries.");
    }

    const { parentSessionFile, parentSessionId } = this.getSessionInfo();
    if (!parentSessionId) {
      throw new Error("Cannot spawn a subagent without an active parent session.");
    }

    const visitedEntryIds = new Set<string>();
    let entry = sessionManager.getLeafEntry();
    while (isSessionBranchEntry(entry) && !visitedEntryIds.has(entry.id)) {
      visitedEntryIds.add(entry.id);
      if (isAssistantToolCallEntry(entry, toolCallId)) {
        return Object.freeze({
          parentSessionFile,
          parentSessionId,
          parentEntryId: entry.id,
          toolCallId,
        });
      }
      entry = entry.parentId === null ? undefined : sessionManager.getEntry(entry.parentId);
    }

    throw new Error("Cannot spawn a subagent without a matching persisted assistant entry for the current tool call.");
  }
}

/** The narrow entry shape needed to walk one persisted session branch safely. */
type SessionBranchEntry = {
  id: string;
  parentId: string | null;
  type: string;
  message?: unknown;
};

function isSessionBranchEntry(value: unknown): value is SessionBranchEntry {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    (typeof value.parentId === "string" || value.parentId === null) &&
    typeof value.type === "string"
  );
}

function isAssistantToolCallEntry(entry: SessionBranchEntry, toolCallId: string): boolean {
  if (entry.type !== "message" || !isRecord(entry.message)) return false;
  if (entry.message.role !== "assistant" || !Array.isArray(entry.message.content)) return false;
  return entry.message.content.some(
    (block) => isRecord(block) && block.type === "toolCall" && block.id === toolCallId,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Create a fully-initialized SubagentRuntime with default values.
 *
 * Call once at extension startup; pass the result to factories and handlers.
 */
export function createSubagentRuntime(): SubagentRuntime {
  return new SubagentRuntime();
}
