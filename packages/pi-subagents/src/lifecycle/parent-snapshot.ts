/**
 * parent-snapshot.ts — Capture parent session state as a plain data snapshot.
 */

import type { Model } from "@earendil-works/pi-ai";
import { buildParentContext } from "#src/session/context";
import type { ModelRegistry } from "#src/session/model-resolver";
import type { SessionContext } from "#src/types";

/**
 * Plain data snapshot of the parent session state captured at spawn time.
 * Replaces live `ExtensionContext` references so queued agents don't read stale state.
 */
export interface ParentSnapshot {
  /** Parent working directory. */
  cwd: string;
  /** Parent's effective system prompt (for append-mode agents). */
  systemPrompt: string;
  /** Parent's current model instance (fallback when agent config has no model). */
  model: Model<any> | undefined;
  /** Model registry for resolving config.model strings and creating sessions. */
  modelRegistry: ModelRegistry;
  /** Auth storage for credential resolution (OAuth tokens, API keys). */
  authStorage?: unknown;
  /** Model runtime for Pi SDK session creation. */
  modelRuntime?: unknown;
  /** Pre-built parent conversation text (when inheritContext was requested). */
  parentContext?: string;
}

/**
 * Build an immutable snapshot of the parent session state.
 *
 * Called once at spawn time so queued agents capture state as it existed
 * when the user requested the agent, not when a queue slot opens.
 */
export function buildParentSnapshot(
  ctx: SessionContext,
  inheritContext?: boolean,
): ParentSnapshot {
  const parentContext = inheritContext ? buildParentContext(ctx) : undefined;
  const registryRecord = ctx.modelRegistry as unknown as Record<string, unknown>;
  const ctxRecord = ctx as unknown as Record<string, unknown>;
  const modelRuntime = registryRecord.runtime ?? ctxRecord.modelRuntime;
  const runtimeRecord = modelRuntime as Record<string, unknown> | undefined;
  const authStorage = registryRecord.authStorage ?? runtimeRecord?.credentials ?? ctxRecord.authStorage;

  return {
    cwd: ctx.cwd,
    systemPrompt: ctx.getSystemPrompt(),
    model: ctx.model,
    modelRegistry: ctx.modelRegistry,
    authStorage,
    modelRuntime,
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- || intentional: converts empty string to undefined as well as null/undefined
    parentContext: parentContext || undefined,
  };
}
