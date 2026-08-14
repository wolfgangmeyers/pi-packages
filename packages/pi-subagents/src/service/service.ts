/**
 * service.ts — Public API surface for cross-extension access to subagents.
 *
 * Consumers declare this package as an optional peer dependency and use
 * dynamic import to access the accessor functions:
 *
 *   const { getSubagentsService } = await import("@gotgenes/pi-subagents");
 *   const svc = getSubagentsService(ctx.sessionManager.getSessionId());
 *   svc?.spawn("Explore", "Check for stale TODOs");
 */

import type { SubagentStatus } from "#src/lifecycle/subagent";
import type { LifetimeUsage } from "#src/lifecycle/usage";
import type {
  Workspace,
  WorkspaceDisposeOutcome,
  WorkspaceDisposeResult,
  WorkspacePrepareContext,
  WorkspaceProvider,
} from "#src/lifecycle/workspace";


// SubagentStatus is defined in the lifecycle layer (single home) and re-exported
// here for the public API surface — mirrors the LifetimeUsage / workspace pattern.
export type { SubagentStatus } from "#src/lifecycle/subagent";

/** Redacted live lifecycle view intended for cross-extension observation. */
export interface SubagentLifecycleSnapshot {
  readonly id: string;
  readonly type: string;
  readonly description: string;
  readonly status: SubagentStatus;
}

export type SubagentLifecycleListener = (snapshot: SubagentLifecycleSnapshot) => void;
// Generative extension seam (ADR 0002, Phase 16 Step 2). The provider type
// and all four collaborator types it references are re-exported by name so
// consumers can import them directly rather than recovering them via
// indexed-access inference (e.g. `Parameters<WorkspaceProvider["prepare"]>[0]`).
export type {
  LifetimeUsage,
  Workspace,
  WorkspaceDisposeOutcome,
  WorkspaceDisposeResult,
  WorkspacePrepareContext,
  WorkspaceProvider,
};

/** Serializable snapshot of an agent's state — no live session objects. */
export interface SubagentRecord {
  id: string;
  type: string;
  description: string;
  status: SubagentStatus;
  result?: string;
  error?: string;
  toolUses: number;
  startedAt: number;
  completedAt?: number;
  lifetimeUsage: LifetimeUsage;
  compactionCount: number;
}

/** Options for spawning an agent via the service. */
export interface SpawnOptions {
  description?: string;
  model?: string;
  maxTurns?: number;
  thinkingLevel?: string;
  inheritContext?: boolean;
  /** Start immediately without queue admission; spawn still returns before completion. */
  bypassQueue?: boolean;
}

/** The public service contract for cross-extension subagent access. */
export interface SubagentsService {
  /** Spawn a background agent. Returns the agent ID immediately. */
  spawn(type: string, prompt: string, options?: SpawnOptions): string;

  /** Get a snapshot of an agent's current state. */
  getRecord(id: string): SubagentRecord | undefined;

  /** List all tracked agents, most recent first. */
  listAgents(): SubagentRecord[];

  /** Abort a running or queued agent. Returns false if not found. */
  abort(id: string): boolean;

  /** Send a steering message to a running agent. */
  steer(id: string, message: string): Promise<boolean>;

  /** Whether any agents are running or queued. */
  hasRunning(): boolean;

  /** Subscribe to redacted live lifecycle snapshots. Returns an unsubscribe function. */
  subscribeLifecycle(listener: SubagentLifecycleListener): () => void;

  /** Return the currently active redacted lifecycle snapshots. */
  getLifecycleSnapshots(): readonly SubagentLifecycleSnapshot[];

  /**
   * Register the single workspace provider that supplies a child's working
   * directory plus bracketed setup/teardown. Throws if one is already
   * registered. Returns a disposer that unregisters the provider.
   */
  registerWorkspaceProvider(provider: WorkspaceProvider): () => void;
}

/** Event channel constants for pi.events subscriptions. */
export const SUBAGENT_EVENTS = {
  STARTED: "subagents:started",
  COMPLETED: "subagents:completed",
  FAILED: "subagents:failed",
  RESUMED: "subagents:resumed",
  COMPACTED: "subagents:compacted",
  CREATED: "subagents:created",
  STEERED: "subagents:steered",
} as const;

// ---- Accessor functions ----

const SERVICE_REGISTRY_KEY = Symbol.for("@gotgenes/pi-subagents:service-registry");
const MAX_REGISTERED_SERVICES = 100;

/** Receives the current service for one owner whenever its registration changes. */
export type SubagentsServiceListener = (service: SubagentsService | undefined) => void;

interface SubagentsServiceRegistry {
  readonly services: Map<string, SubagentsService>;
  readonly listeners: Map<string, Set<SubagentsServiceListener>>;
}

/**
 * Publish a service for one owning Pi session.
 *
 * Publication replaces only the service registered for `ownerSessionId` and
 * synchronously notifies that owner's subscribers. Re-publishing the same
 * object refreshes its bounded-registry recency without notifying again.
 */
export function publishSubagentsService(
  ownerSessionId: string,
  service: SubagentsService,
): void {
  const registry = getOrCreateServiceRegistry();
  const previous = registry.services.get(ownerSessionId);
  registry.services.delete(ownerSessionId);
  registry.services.set(ownerSessionId, service);
  evictOldestServices(registry);
  if (previous !== service && registry.services.get(ownerSessionId) === service) {
    notifyServiceListeners(registry, ownerSessionId, service);
  }
}

/** Retrieve one owner's service and refresh its bounded-registry recency. */
export function getSubagentsService(ownerSessionId: string): SubagentsService | undefined {
  const registry = getServiceRegistry();
  if (!registry) return undefined;
  const service = registry.services.get(ownerSessionId);
  if (!service) return undefined;
  registry.services.delete(ownerSessionId);
  registry.services.set(ownerSessionId, service);
  return service;
}

/**
 * Remove one owner's service if `service` is still its registered object.
 *
 * The identity check makes cleanup from a stale extension instance harmless.
 */
export function unpublishSubagentsService(
  ownerSessionId: string,
  service: SubagentsService,
): void {
  const registry = getServiceRegistry();
  if (registry?.services.get(ownerSessionId) !== service) return;
  registry.services.delete(ownerSessionId);
  notifyServiceListeners(registry, ownerSessionId, undefined);
  deleteRegistryWhenEmpty(registry);
}

/**
 * Subscribe to publication changes for one owner.
 *
 * The listener is called synchronously with the current service (including
 * `undefined`) and after each replacement or active-service removal. Listener
 * errors are isolated. The returned function removes only this subscription.
 */
export function subscribeSubagentsService(
  ownerSessionId: string,
  listener: SubagentsServiceListener,
): () => void {
  const registry = getOrCreateServiceRegistry();
  const listeners = registry.listeners.get(ownerSessionId) ?? new Set();
  listeners.add(listener);
  registry.listeners.set(ownerSessionId, listeners);
  callServiceListener(listener, getSubagentsService(ownerSessionId));
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) registry.listeners.delete(ownerSessionId);
    deleteRegistryWhenEmpty(registry);
  };
}

function getServiceRegistry(): SubagentsServiceRegistry | undefined {
  return (globalThis as Record<symbol, unknown>)[SERVICE_REGISTRY_KEY] as
    | SubagentsServiceRegistry
    | undefined;
}

function getOrCreateServiceRegistry(): SubagentsServiceRegistry {
  const existing = getServiceRegistry();
  if (existing) return existing;
  const registry: SubagentsServiceRegistry = {
    services: new Map(),
    listeners: new Map(),
  };
  (globalThis as Record<symbol, unknown>)[SERVICE_REGISTRY_KEY] = registry;
  return registry;
}

function evictOldestServices(registry: SubagentsServiceRegistry): void {
  while (registry.services.size > MAX_REGISTERED_SERVICES) {
    const oldestOwnerSessionId = registry.services.keys().next().value;
    if (oldestOwnerSessionId === undefined) return;
    registry.services.delete(oldestOwnerSessionId);
    notifyServiceListeners(registry, oldestOwnerSessionId, undefined);
  }
}

function notifyServiceListeners(
  registry: SubagentsServiceRegistry,
  ownerSessionId: string,
  service: SubagentsService | undefined,
): void {
  for (const listener of registry.listeners.get(ownerSessionId) ?? []) {
    callServiceListener(listener, service);
  }
}

function callServiceListener(
  listener: SubagentsServiceListener,
  service: SubagentsService | undefined,
): void {
  try {
    listener(service);
  } catch {
    // One extension's listener must not block registry publication or cleanup.
  }
}

function deleteRegistryWhenEmpty(registry: SubagentsServiceRegistry): void {
  if (registry.services.size > 0 || registry.listeners.size > 0) return;
  if (getServiceRegistry() !== registry) return;
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- removes the process-global registry after its final owner and subscriber leave
  delete (globalThis as Record<symbol, unknown>)[SERVICE_REGISTRY_KEY];
}
