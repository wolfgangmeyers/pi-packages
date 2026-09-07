/**
 * subagent-manager.ts - Tracks subagents, background execution, resume support.
 *
 * Agents are subject to a configurable concurrency limit (default: 4).
 * Excess agents are scheduled on a ConcurrencyLimiter and auto-started as running
 * agents complete. Queue bypass starts work immediately but still returns asynchronously.
 */

import { randomBytes, randomUUID } from "node:crypto";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionFactory, InlineExtension } from "@earendil-works/pi-coding-agent";
import { debugLog } from "#src/debug";
import type { ConcurrencyLimiter } from "#src/lifecycle/concurrency-limiter";
import type { CreateSubagentSessionParams } from "#src/lifecycle/create-subagent-session";
import type { ParentSnapshot } from "#src/lifecycle/parent-snapshot";
import { Subagent, type SubagentLifecycleObserver } from "#src/lifecycle/subagent";
import type { SubagentSession } from "#src/lifecycle/subagent-session";
import { SubagentState } from "#src/lifecycle/subagent-state";
import type { WorkspaceProvider } from "#src/lifecycle/workspace";
import { journalSubagentError, journalSubagentEvent } from "#src/observation/instrumentation";

import type { RunConfig } from "#src/runtime";
import type {
  ChildExtensionRegistrationV1,
  SubagentLifecycleListener,
  SubagentLifecycleSnapshot,
} from "#src/service/service";
import type {
  AgentInvocation,
  BoundedJsonObjectV1,
  BoundedJsonValueV1,
  CompactionInfo,
  ContextRefV1,
  ControlResultAppendErrorCodeV1,
  ControlResultAppendOutcomeV1,
  ControlResultPayloadV1,
  LifecycleSnapshotV2ServiceResult,
  LifecycleSnapshotV2ServiceRow,
  ParentSessionInfo,
  SourceChildV2,
  SubagentLifecycleDeltaV2,
  SubagentType,
  ThinkingLevel,
} from "#src/types";

/** Hard cap for the redacted live projection; authoritative records are unaffected. */
export const MAX_LIFECYCLE_SNAPSHOTS = 100;

/** Bounded source projection limits for the internal lifecycle V2 manager seam. */
export const MAX_SOURCE_CHILDREN_PER_SNAPSHOT = 256;
export const MAX_SNAPSHOT_NODES = 2_048;
export const MAX_SNAPSHOT_UTF8_BYTES = 32 * 1024;
export const MAX_V2_STRING_UTF8_BYTES = 8 * 1024;

const LIFECYCLE_V2_SEQUENCE_REGISTRY_KEY = Symbol.for("@gotgenes/pi-subagents/lifecycle-v2-sequence-registry");
const LIFECYCLE_V2_SNAPSHOT_ID_PLACEHOLDER = "00000000-0000-4000-8000-000000000000";
const MAX_LIFECYCLE_V2_SEQUENCE_OWNERS = 100;
const MAX_CHILD_EXTENSION_FACTORIES_PER_OWNER = 16;
const CHILD_EXTENSION_FACTORY_NAME = /^[a-z][a-z0-9_-]{0,95}$/;

export type LifecycleV2ReleaseDisposition = "reload" | "quit" | "new" | "resume" | "fork" | "disposed-child";
type LifecycleV2MutableFields = Pick<
  SourceChildV2,
  "description" | "model" | "lifecycle_state" | "started_at" | "finished_at" | "duration_ms" | "compaction"
>;
type LifecycleV2Changes = SubagentLifecycleDeltaV2["changes"];
type LifecycleV2Listener = (row: LifecycleSnapshotV2ServiceRow, delta: SubagentLifecycleDeltaV2) => void;

interface LifecycleV2RecordState {
  ownerSessionId: string;
  runId: string;
  fingerprint: string;
  sequence: number;
  fields: LifecycleV2MutableFields;
}

/** One manager-local capability binding for an exact live child run and session object. */
interface ControlContextBindingV1 {
  readonly contextRef: ContextRefV1;
  readonly ownerSessionId: string;
  readonly parentEntryId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly childSession: SubagentSession;
  readonly inFlightResults: Map<string, string>;
  stopObservingPersistedResults: () => void;
}

type ControlPayloadValidation =
  | { kind: "valid"; payload: ControlResultPayloadV1 }
  | { kind: "invalid"; code: "INVALID_ENVELOPE" | "PAYLOAD_TOO_LARGE"; message: string };

const MAX_CONTROL_RESULT_ENVELOPE_UTF8_BYTES = 64 * 1024;
const MAX_CONTROL_RESULT_CONTENT_UTF8_BYTES = 16 * 1024;
const MAX_CONTROL_RESULT_DETAILS_UTF8_BYTES = 16 * 1024;
const MAX_CONTROL_RESULT_JSON_DEPTH = 8;
const MAX_CONTROL_RESULT_JSON_NODES = 1_024;
const MAX_CONTROL_RESULT_JSON_PROPERTIES = 128;
const MAX_CONTROL_RESULT_JSON_ARRAY_ITEMS = 256;
const MAX_CONTROL_RESULT_JSON_STRING_UTF8_BYTES = 8 * 1024;
const MAX_CONTROL_RESULT_IN_FLIGHT = 128;
const UUID_V1_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const CONTEXT_REF_V1_PATTERN = /^ctx1_[A-Za-z0-9_-]{43}$/;

interface LifecycleV2SequenceRegistryEntry {
  ownerSessionId: string;
  lastSequence: number;
  lastTouched: number;
  activeClaims: number;
}

interface LifecycleV2SequenceRegistry {
  entries: Map<string, LifecycleV2SequenceRegistryEntry>;
  nextTouch: number;
}

function isLifecycleV2SequenceRegistry(value: unknown): value is LifecycleV2SequenceRegistry {
  return value !== null
    && typeof value === "object"
    && Reflect.get(value, "entries") instanceof Map
    && typeof Reflect.get(value, "nextTouch") === "number";
}

function getLifecycleV2SequenceRegistry(): LifecycleV2SequenceRegistry {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, LIFECYCLE_V2_SEQUENCE_REGISTRY_KEY);
  const existing: unknown = descriptor?.value;
  if (existing !== undefined) {
    if (!isLifecycleV2SequenceRegistry(existing)) {
      throw new Error("Lifecycle V2 sequence registry has an invalid process-global value.");
    }
    return existing;
  }
  const registry: LifecycleV2SequenceRegistry = { entries: new Map(), nextTouch: 0 };
  Object.defineProperty(globalThis, LIFECYCLE_V2_SEQUENCE_REGISTRY_KEY, {
    value: registry,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  return registry;
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !isUnknownArray(value);
}

/** Clone only plain JSON data so validation cannot be bypassed by getters, prototypes, or later mutation. */
function ownDataRecord(value: unknown): Record<string, unknown> | undefined {
  if (!isObjectRecord(value)) return undefined;
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  if (Object.getOwnPropertySymbols(value).length > 0) return undefined;
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !isEnumerableDataDescriptor(descriptor)) return undefined;
    copy[key] = descriptor.value;
  }
  return copy;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isEnumerableDataDescriptor(
  descriptor: PropertyDescriptor,
): descriptor is Omit<PropertyDescriptor, "value"> & { value: unknown } {
  return Object.hasOwn(descriptor, "value") && descriptor.enumerable === true;
}

function isContextRefV1(value: string): value is ContextRefV1 {
  return CONTEXT_REF_V1_PATTERN.test(value);
}

interface JsonValidationState {
  nodes: number;
  properties: number;
  seen: WeakSet<object>;
}

/** Validate and clone the bounded operation-specific JSON object without coercion. */
function cloneBoundedJsonValue(value: unknown, state: JsonValidationState, depth: number): BoundedJsonValueV1 | undefined {
  state.nodes++;
  if (state.nodes > MAX_CONTROL_RESULT_JSON_NODES || depth > MAX_CONTROL_RESULT_JSON_DEPTH) return undefined;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    return Buffer.byteLength(value, "utf8") <= MAX_CONTROL_RESULT_JSON_STRING_UTF8_BYTES ? value : undefined;
  }
  if (isUnknownArray(value)) {
    if (value.length > MAX_CONTROL_RESULT_JSON_ARRAY_ITEMS || state.seen.has(value)) return undefined;
    state.seen.add(value);
    const copy: BoundedJsonValueV1[] = [];
    for (const item of value) {
      const cloned = cloneBoundedJsonValue(item, state, depth + 1);
      if (cloned === undefined) return undefined;
      copy.push(cloned);
    }
    state.seen.delete(value);
    return copy;
  }
  const record = ownDataRecord(value);
  if (!record || state.seen.has(record)) return undefined;
  state.seen.add(record);
  const keys = Object.keys(record);
  state.properties += keys.length;
  if (keys.length > MAX_CONTROL_RESULT_JSON_PROPERTIES || state.properties > MAX_CONTROL_RESULT_JSON_PROPERTIES) return undefined;
  const copy: BoundedJsonObjectV1 = {};
  for (const key of keys) {
    if (Buffer.byteLength(key, "utf8") > MAX_CONTROL_RESULT_JSON_STRING_UTF8_BYTES) return undefined;
    const cloned = cloneBoundedJsonValue(record[key], state, depth + 1);
    if (cloned === undefined) return undefined;
    copy[key] = cloned;
  }
  state.seen.delete(record);
  return copy;
}

function isBoundedJsonObject(value: BoundedJsonValueV1 | undefined): value is BoundedJsonObjectV1 {
  return value !== null && typeof value === "object" && !isUnknownArray(value);
}

function validateControlResultPayload(value: unknown): ControlPayloadValidation {
  const payload = ownDataRecord(value);
  const payloadKeys = [
    "protocol", "result_id", "request_id", "target_session_epoch", "runtime_generation",
    "manifest_sha256", "status", "content", "details", "error",
  ];
  const okKeys = payloadKeys.filter((key) => key !== "error");
  if (!payload || (!hasExactKeys(payload, payloadKeys) && !hasExactKeys(payload, okKeys))) {
    return { kind: "invalid", code: "INVALID_ENVELOPE", message: "Control result has an unknown or missing field." };
  }
  const resultId = payload.result_id;
  const requestId = payload.request_id;
  const targetSessionEpoch = payload.target_session_epoch;
  const runtimeGeneration = payload.runtime_generation;
  const manifestSha256 = payload.manifest_sha256;
  const status = payload.status;
  const content = payload.content;
  if (
    payload.protocol !== "mecha.control/v1"
    || typeof resultId !== "string" || !UUID_V1_PATTERN.test(resultId)
    || typeof requestId !== "string" || !UUID_V1_PATTERN.test(requestId)
    || typeof targetSessionEpoch !== "number" || !Number.isSafeInteger(targetSessionEpoch) || targetSessionEpoch < 0
    || typeof runtimeGeneration !== "string" || !UUID_V1_PATTERN.test(runtimeGeneration)
    || typeof manifestSha256 !== "string" || !SHA256_HEX_PATTERN.test(manifestSha256)
    || (status !== "ok" && status !== "error")
    || typeof content !== "string"
  ) {
    return { kind: "invalid", code: "INVALID_ENVELOPE", message: "Control result has an invalid field value." };
  }
  if (Buffer.byteLength(content, "utf8") > MAX_CONTROL_RESULT_CONTENT_UTF8_BYTES) {
    return { kind: "invalid", code: "PAYLOAD_TOO_LARGE", message: "Control result content exceeds the 16 KiB limit." };
  }
  if (!ownDataRecord(payload.details)) {
    return { kind: "invalid", code: "INVALID_ENVELOPE", message: "Control result details must be an object." };
  }
  const details = cloneBoundedJsonValue(payload.details, { nodes: 0, properties: 0, seen: new WeakSet() }, 0);
  if (!isBoundedJsonObject(details)) {
    return { kind: "invalid", code: "PAYLOAD_TOO_LARGE", message: "Control result details exceed structural limits." };
  }
  if (Buffer.byteLength(JSON.stringify(details), "utf8") > MAX_CONTROL_RESULT_DETAILS_UTF8_BYTES) {
    return { kind: "invalid", code: "PAYLOAD_TOO_LARGE", message: "Control result details exceed the 16 KiB limit." };
  }

  let error: ControlResultPayloadV1["error"];
  if (status === "error") {
    const candidate = ownDataRecord(payload.error);
    if (!candidate || !hasExactKeys(candidate, ["code", "message", "retryable"])
      || typeof candidate.code !== "string" || typeof candidate.message !== "string" || typeof candidate.retryable !== "boolean") {
      return { kind: "invalid", code: "INVALID_ENVELOPE", message: "An error result requires a closed error object." };
    }
    error = { code: candidate.code, message: candidate.message, retryable: candidate.retryable };
  } else if (payload.error !== undefined) {
    return { kind: "invalid", code: "INVALID_ENVELOPE", message: "An ok result cannot include an error object." };
  }

  const normalized: ControlResultPayloadV1 = {
    protocol: "mecha.control/v1",
    result_id: resultId,
    request_id: requestId,
    target_session_epoch: targetSessionEpoch,
    runtime_generation: runtimeGeneration,
    manifest_sha256: manifestSha256,
    status,
    content,
    details,
    ...(error === undefined ? {} : { error }),
  };
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > MAX_CONTROL_RESULT_ENVELOPE_UTF8_BYTES) {
    return { kind: "invalid", code: "PAYLOAD_TOO_LARGE", message: "Control result exceeds the 64 KiB envelope limit." };
  }
  return { kind: "valid", payload: normalized };
}

function controlPayloadFingerprint(payload: ControlResultPayloadV1): string {
  return canonicalControlJson(payload);
}

function canonicalControlJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (isUnknownArray(value)) return `[${value.map(canonicalControlJson).join(",")}]`;
  const record = ownDataRecord(value);
  if (!record) throw new Error("Validated control payload stopped being plain JSON.");
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalControlJson(record[key])}`).join(",")}}`;
}

function controlResultRejected(code: ControlResultAppendErrorCodeV1, message: string, retryable: boolean): ControlResultAppendOutcomeV1 {
  return { kind: "rejected", error: { code, message, retryable } };
}

/** Enumerate nested data through an unknown boundary without allowing `any` to propagate. */
function nestedValues(value: unknown): readonly unknown[] {
  if (isUnknownArray(value)) return value;
  if (isObjectRecord(value)) return Object.values(value);
  return [];
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const nested of nestedValues(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function countSnapshotNodes(value: unknown): number {
  if (value === null || typeof value !== "object") return 1;
  return 1 + nestedValues(value).reduce<number>((count, item) => count + countSnapshotNodes(item), 0);
}

function containsOversizedSourceString(value: unknown): boolean {
  if (typeof value === "string") return Buffer.byteLength(value, "utf8") > MAX_V2_STRING_UTF8_BYTES;
  if (value === null || typeof value !== "object") return false;
  return nestedValues(value).some((nested) => containsOversizedSourceString(nested));
}

/** V2 listeners only receive complete payloads that satisfy the source envelope limits. */
function isBoundedLifecycleV2Payload(value: unknown): boolean {
  return !containsOversizedSourceString(value)
    && countSnapshotNodes(value) <= MAX_SNAPSHOT_NODES
    && Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_SNAPSHOT_UTF8_BYTES;
}

/** A delta is only safe when its complete row also has a bounded snapshot fallback. */
function isBoundedLifecycleV2SourceEnvelope(ownerSessionId: string, row: SourceChildV2): boolean {
  return isBoundedLifecycleV2Payload({
    protocol: "mecha.children/v1",
    snapshot_id: LIFECYCLE_V2_SNAPSHOT_ID_PLACEHOLDER,
    owner_session_id: ownerSessionId,
    sequence: row.sequence,
    runs: [row],
  });
}

function sourceStateOrder(row: SourceChildV2): number {
  if (row.lifecycle_state === "queued") return 0;
  if (row.lifecycle_state === "running") return 1;
  return 2;
}

function compareSourceChildren(a: SourceChildV2, b: SourceChildV2): number {
  return sourceStateOrder(a) - sourceStateOrder(b)
    || b.started_at.localeCompare(a.started_at)
    || a.task_id.localeCompare(b.task_id)
    || a.run_id.localeCompare(b.run_id);
}

function mutableFields(row: SourceChildV2): LifecycleV2MutableFields {
  return {
    description: row.description,
    model: row.model === null ? null : { ...row.model },
    lifecycle_state: row.lifecycle_state,
    started_at: row.started_at,
    finished_at: row.finished_at,
    duration_ms: row.duration_ms,
    compaction: { ...row.compaction },
  };
}

function changedMutableFields(previous: LifecycleV2MutableFields, current: LifecycleV2MutableFields): LifecycleV2Changes {
  const changes: LifecycleV2Changes = {};
  if (previous.description !== current.description) changes.description = current.description;
  if (JSON.stringify(previous.model) !== JSON.stringify(current.model)) changes.model = current.model === null ? null : { ...current.model };
  if (previous.lifecycle_state !== current.lifecycle_state) changes.lifecycle_state = current.lifecycle_state;
  if (previous.started_at !== current.started_at) changes.started_at = current.started_at;
  if (previous.finished_at !== current.finished_at) changes.finished_at = current.finished_at;
  if (previous.duration_ms !== current.duration_ms) changes.duration_ms = current.duration_ms;
  if (JSON.stringify(previous.compaction) !== JSON.stringify(current.compaction)) changes.compaction = { ...current.compaction };
  return changes;
}

/**
 * Session-retention windows (minutes). `SettingsManager` satisfies this
 * structurally; a live getter (`getRetentionPolicy`) lets the sweep read the
 * current values without a construction-time settings dependency.
 */
export interface RetentionPolicy {
  readonly consumedSessionRetentionMinutes: number;
  readonly unconsumedSessionRetentionMinutes: number;
}

const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  consumedSessionRetentionMinutes: 10,
  unconsumedSessionRetentionMinutes: 720,
};

/** Observer interface for agent lifecycle notifications. */
export interface SubagentManagerObserver {
  onSubagentStarted(record: Subagent): void;
  onSubagentCompleted(record: Subagent): void;
  /** Fires when a resumed run reaches a terminal state (distinct from a fresh completion). */
  onSubagentResumed(record: Subagent): void;
  onSubagentCompacted(record: Subagent, info: CompactionInfo): void;
  /** Fires synchronously after an agent record is created (before run). */
  onSubagentCreated(record: Subagent): void;
}

export interface SubagentManagerOptions {
  /** Assembly factory that produces a born-complete SubagentSession per spawn. */
  createSubagentSession: (params: CreateSubagentSessionParams) => Promise<SubagentSession>;
  /** Concurrency limiter — schedules run thunks FIFO against the limit. */
  limiter: ConcurrencyLimiter;
  /** Base working directory handed to a workspace provider (the parent cwd). */
  baseCwd: string;
  getRunConfig?: () => RunConfig;
  /** Live accessor for the session-retention windows; defaults applied when absent. */
  getRetentionPolicy?: () => RetentionPolicy;
  observer?: SubagentManagerObserver;
}

export interface AgentSpawnConfig {
  description: string;
  model?: Model<any>;
  maxTurns?: number;
  inheritContext?: boolean;
  thinkingLevel?: ThinkingLevel;
  /**
   * Skip the maxConcurrent queue check for this spawn - start immediately even
   * if the configured concurrency limit would otherwise queue it. The spawn
   * still returns the agent ID immediately and never waits for completion.
   */
  bypassQueue?: boolean;
  /** Resolved invocation snapshot captured for UI display. */
  invocation?: AgentInvocation;
  /** Parent abort signal - when aborted, the subagent is also stopped. */
  signal?: AbortSignal;
  /** Per-subagent lifecycle observer — replaces onSessionCreated callback. */
  observer?: SubagentLifecycleObserver;
  /** Parent session identity - grouped fields that travel together from the tool boundary. */
  parentSession?: ParentSessionInfo;
}

export class SubagentManager {
  private agents = new Map<string, Subagent>();
  private lifecycleSnapshots = new Map<string, SubagentLifecycleSnapshot>();
  private lifecycleListeners = new Set<SubagentLifecycleListener>();
  private lifecycleV2Listeners = new Set<LifecycleV2Listener>();
  /** Current-run fingerprints only; this intentionally retains no V2 run history. */
  private lifecycleV2RecordStates = new Map<string, LifecycleV2RecordState>();
  /** In-memory references are capability bindings for exact live child sessions, never durable history. */
  private controlContextsByRef = new Map<ContextRefV1, ControlContextBindingV1>();
  private controlContextRefByTask = new Map<string, ContextRefV1>();
  /** Process-global registry claims held by this manager for explicit lifecycle release. */
  private lifecycleV2OwnerClaims = new Set<string>();
  /** Code-owned child factories grouped by the exact parent service owner. */
  private childExtensionFactoriesByOwner = new Map<string, Map<string, ExtensionFactory>>();
  private disposed = false;
  private sweepInterval: ReturnType<typeof setInterval>;
  private readonly observer?: SubagentManagerObserver;
  private readonly createSubagentSession: (params: CreateSubagentSessionParams) => Promise<SubagentSession>;
  private readonly limiter: ConcurrencyLimiter;
  private readonly baseCwd: string;
  private getRunConfig?: () => RunConfig;
  private getRetentionPolicy?: () => RetentionPolicy;
  private _workspaceProvider?: WorkspaceProvider;

  /** The registered workspace provider, or undefined when none is registered. */
  get workspaceProvider(): WorkspaceProvider | undefined {
    return this._workspaceProvider;
  }

  constructor(options: SubagentManagerOptions) {
    this.createSubagentSession = options.createSubagentSession;
    this.limiter = options.limiter;
    this.baseCwd = options.baseCwd;
    this.observer = options.observer;
    this.getRunConfig = options.getRunConfig;
    this.getRetentionPolicy = options.getRetentionPolicy;
    // Periodically release the heavy session of terminal agents past their
    // retention window. The lightweight record (with its result) is kept for the
    // session lifetime, so get_subagent_result never misses in-session.
    this.sweepInterval = setInterval(() => this.sweep(), 60_000);
    this.sweepInterval.unref();
  }

  /**
   * Register the single workspace provider. Throws if one is already
   * registered (chaining is out of scope — see ADR 0002). Returns a disposer
   * that clears the slot only if this provider is still the active one.
   */
  registerWorkspaceProvider(provider: WorkspaceProvider): () => void {
    if (this._workspaceProvider) {
      throw new Error(
        "A WorkspaceProvider is already registered; only one is supported.",
      );
    }
    this._workspaceProvider = provider;
    return () => {
      if (this._workspaceProvider === provider) this._workspaceProvider = undefined;
    };
  }

  /**
   * Register one fixed code-owned factory for future children of an owner.
   * The name is a bounded collision domain, and callers only receive a disposer
   * for their own exact registration. Child creation takes an immutable list
   * snapshot, so later disposal cannot affect a child that has already spawned.
   */
  registerChildExtensionV1(
    ownerSessionId: string,
    registration: ChildExtensionRegistrationV1,
  ): () => void {
    if (typeof ownerSessionId !== "string" || ownerSessionId.length === 0 || Buffer.byteLength(ownerSessionId, "utf8") > MAX_V2_STRING_UTF8_BYTES) {
      throw new Error("Child extension factory owner must be a bounded session ID.");
    }
    if (!CHILD_EXTENSION_FACTORY_NAME.test(registration.name) || typeof registration.factory !== "function") {
      throw new Error("Child extension factory registration is invalid.");
    }
    const factories = this.childExtensionFactoriesByOwner.get(ownerSessionId) ?? new Map<string, ExtensionFactory>();
    if (factories.has(registration.name)) {
      throw new Error("Child extension factory name is already registered for this owner.");
    }
    if (factories.size >= MAX_CHILD_EXTENSION_FACTORIES_PER_OWNER) {
      throw new Error(`Child extension factory limit (${MAX_CHILD_EXTENSION_FACTORIES_PER_OWNER}) reached for this owner.`);
    }
    factories.set(registration.name, registration.factory);
    this.childExtensionFactoriesByOwner.set(ownerSessionId, factories);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (this.childExtensionFactoriesByOwner.get(ownerSessionId) !== factories || factories.get(registration.name) !== registration.factory) return;
      factories.delete(registration.name);
      if (factories.size === 0) this.childExtensionFactoriesByOwner.delete(ownerSessionId);
    };
  }

  /** Clear all factories belonging to an owner during service release or shutdown. */
  releaseChildExtensionFactoriesForOwner(ownerSessionId: string): void {
    this.childExtensionFactoriesByOwner.delete(ownerSessionId);
  }

  /** Subscribe to redacted live lifecycle snapshots. */
  subscribeLifecycle(listener: SubagentLifecycleListener): () => void {
    this.lifecycleListeners.add(listener);
    return () => this.lifecycleListeners.delete(listener);
  }

  /** Return a defensive copy of the active lifecycle projection. */
  getLifecycleSnapshots(): readonly SubagentLifecycleSnapshot[] {
    return [...this.lifecycleSnapshots.values()];
  }

  /**
   * Subscribe to the internal V2 source-update seam. This stays manager-local
   * until a later adapter owns public delivery and Pi event wiring.
   */
  subscribeLifecycleV2(listener: LifecycleV2Listener): () => void {
    this.lifecycleV2Listeners.add(listener);
    return () => this.lifecycleV2Listeners.delete(listener);
  }

  /** Return a new, bounded, deeply frozen service snapshot for one immutable owner. */
  getLifecycleSnapshotV2(ownerSessionId: string): LifecycleSnapshotV2ServiceResult {
    this.assertLifecycleV2Owner(ownerSessionId);
    const registry = getLifecycleV2SequenceRegistry();
    const ownerEntry = registry.entries.get(ownerSessionId);
    if (ownerEntry) this.touchLifecycleV2Owner(ownerEntry, registry);

    const snapshot: LifecycleSnapshotV2ServiceResult = {
      protocol: "mecha.children/v1",
      snapshot_id: randomUUID(),
      owner_session_id: ownerSessionId,
      sequence: ownerEntry?.lastSequence ?? 0,
      runs: [],
    };
    const candidates: LifecycleSnapshotV2ServiceRow[] = [];
    for (const record of this.agents.values()) {
      if (record.lifecycleOwnerSessionId !== ownerSessionId || record.lifecycleParentEntryId === undefined) continue;
      const state = this.lifecycleV2RecordStates.get(record.id);
      const run = record.getLifecycleRunV2();
      // A row is source-backed only after a manager-observed mutation assigned
      // its run's sequence. Never manufacture one during a read.
      if (state?.ownerSessionId !== ownerSessionId || state.runId !== run.run_id) continue;
      candidates.push(this.projectLifecycleV2ServiceRow(record, state.sequence));
    }

    for (const candidate of candidates.sort(compareSourceChildren)) {
      if (snapshot.runs.length >= MAX_SOURCE_CHILDREN_PER_SNAPSHOT) break;
      if (containsOversizedSourceString(candidate)) continue;
      snapshot.runs.push(candidate);
      if (
        countSnapshotNodes(snapshot) > MAX_SNAPSHOT_NODES
        || Buffer.byteLength(JSON.stringify(snapshot), "utf8") > MAX_SNAPSHOT_UTF8_BYTES
      ) {
        snapshot.runs.pop();
      }
    }
    this.assertLifecycleV2SnapshotBounds(snapshot);
    return deepFreeze(snapshot);
  }

  /**
   * Explicit owner claim for later session lifecycle wiring. A bind advances
   * once so an empty replacement manager can publish a newer snapshot.
   */
  bindLifecycleV2Owner(ownerSessionId: string): void {
    this.assertLifecycleV2Owner(ownerSessionId);
    this.claimLifecycleV2Owner(ownerSessionId, true);
  }

  /**
   * Explicit owner release for later lifecycle wiring. Reload preserves only
   * the sequence high-water; every other disposition removes that owner entry.
   */
  releaseLifecycleV2Owner(ownerSessionId: string, disposition: LifecycleV2ReleaseDisposition): void {
    this.releaseChildExtensionFactoriesForOwner(ownerSessionId);
    this.invalidateControlContextsForOwner(ownerSessionId);
    if (!this.lifecycleV2OwnerClaims.delete(ownerSessionId)) return;
    const registry = getLifecycleV2SequenceRegistry();
    const entry = registry.entries.get(ownerSessionId);
    if (!entry) return;
    entry.activeClaims = Math.max(0, entry.activeClaims - 1);
    this.clearLifecycleV2RecordStates(ownerSessionId);
    if (disposition === "reload") {
      this.touchLifecycleV2Owner(entry, registry);
      return;
    }
    if (entry.activeClaims === 0) registry.entries.delete(ownerSessionId);
  }

  /** Central source mutation funnel. It never reads redacted snapshots or runtime/router state. */
  noteLifecycleV2Mutation(record: Subagent): void {
    if (this.disposed) return;
    const ownerSessionId = record.lifecycleOwnerSessionId;
    const parentEntryId = record.lifecycleParentEntryId;
    if (ownerSessionId === undefined || parentEntryId === undefined) return;

    const sourceWithoutSequence = this.projectLifecycleV2Row(record, 0);
    const currentFields = mutableFields(sourceWithoutSequence);
    const contextRef = this.getLiveControlContextRef(record);
    const fingerprint = JSON.stringify({ currentFields, contextRef });
    const previous = this.lifecycleV2RecordStates.get(record.id);
    if (
      previous?.ownerSessionId === ownerSessionId
      && previous.runId === sourceWithoutSequence.run_id
      && previous.fingerprint === fingerprint
    ) {
      const registry = getLifecycleV2SequenceRegistry();
      const entry = registry.entries.get(ownerSessionId);
      if (entry) this.touchLifecycleV2Owner(entry, registry);
      return;
    }

    // Unlike an explicit bind/snapshot request, a live child mutation must not
    // rewrite an invalid source owner. The later explicit operation reports it.
    const entry = this.claimLifecycleV2Owner(ownerSessionId, false, false);
    entry.lastSequence++;
    this.touchLifecycleV2Owner(entry, getLifecycleV2SequenceRegistry());
    const row = this.projectLifecycleV2ServiceRow(record, entry.lastSequence);
    const isNewRun = previous?.ownerSessionId !== ownerSessionId || previous.runId !== row.run_id;
    const previousFields = previous && !isNewRun ? previous.fields : undefined;
    const changes = previousFields === undefined ? mutableFields(row) : changedMutableFields(previousFields, currentFields);
    this.lifecycleV2RecordStates.set(record.id, {
      ownerSessionId,
      runId: row.run_id,
      fingerprint,
      sequence: row.sequence,
      fields: currentFields,
    });
    const immutableRow = deepFreeze(row);
    const delta = deepFreeze({
      protocol: "mecha.children/v1" as const,
      owner_session_id: ownerSessionId,
      sequence: row.sequence,
      task_id: row.task_id,
      run_id: row.run_id,
      parent_entry_id: row.parent_entry_id,
      context_ref: contextRef,
      changes,
    });
    // Keep the authoritative source state intact. A later snapshot can safely
    // omit an oversized row or replace an unsafe delta without truncating it.
    if (
      !isBoundedLifecycleV2Payload(immutableRow)
      || !isBoundedLifecycleV2Payload(delta)
      || !isBoundedLifecycleV2SourceEnvelope(ownerSessionId, immutableRow)
    ) return;
    for (const listener of this.lifecycleV2Listeners) {
      try {
        listener(immutableRow, delta);
      } catch (err) {
        debugLog("lifecycle V2 subscriber", err);
      }
    }
  }

  private publishLifecycle(record: Subagent, terminal = false): void {
    const snapshot = Object.freeze({
      id: record.id,
      type: record.type,
      description: record.description,
      status: record.status,
    });
    if (!terminal) {
      const snapshotWasAtCap =
        this.lifecycleSnapshots.size >= MAX_LIFECYCLE_SNAPSHOTS && !this.lifecycleSnapshots.has(record.id);
      if (snapshotWasAtCap) {
        journalSubagentEvent("subagents.snapshot_capped", {
          snapshot_count: this.lifecycleSnapshots.size,
          subagent_count: this.agents.size,
        });
        const oldest = this.lifecycleSnapshots.keys().next().value;
        if (oldest !== undefined) {
          this.lifecycleSnapshots.delete(oldest);
          journalSubagentEvent("subagents.snapshot_evicted", {
            agent_id: oldest,
            snapshot_count: this.lifecycleSnapshots.size,
          });
        }
      }
      this.lifecycleSnapshots.set(record.id, snapshot);
    }
    // This is a redacted projection. Keep the journal record to an ID and
    // count so diagnostics cannot copy descriptions or other record content.
    journalSubagentEvent("subagents.snapshot_normalized", {
      agent_id: record.id,
      snapshot_count: this.lifecycleSnapshots.size,
    });
    try {
      for (const listener of this.lifecycleListeners) {
        try {
          listener(snapshot);
        } catch (err) {
          journalSubagentError("lifecycle_subscriber", err, {
            agent_id: record.id,
            kind: record.type,
            status: record.status,
          });
          debugLog("lifecycle subscriber", err);
        }
      }
    } finally {
      if (terminal) this.lifecycleSnapshots.delete(record.id);
    }
  }

  /**
   * Append a closed control result to the one live child identified by a manager-issued reference.
   * The binding is checked before touching history so stale calls cannot fall back to the parent.
   */
  async appendControlResultV1(
    contextRef: ContextRefV1,
    payload: ControlResultPayloadV1,
  ): Promise<ControlResultAppendOutcomeV1> {
    const validated = validateControlResultPayload(payload);
    if (validated.kind === "invalid") return controlResultRejected(validated.code, validated.message, false);
    const binding = this.getLiveControlContext(contextRef);
    if (!binding) {
      return controlResultRejected("STALE_CHILD_CONTEXT", "The child context is no longer live.", false);
    }

    const fingerprint = controlPayloadFingerprint(validated.payload);
    const persisted = binding.childSession.findControlResultById(validated.payload.result_id);
    if (persisted !== undefined) {
      binding.inFlightResults.delete(validated.payload.result_id);
      const existing = validateControlResultPayload(persisted);
      if (existing.kind === "valid" && controlPayloadFingerprint(existing.payload) === fingerprint) {
        return { kind: "already_present", result_id: validated.payload.result_id };
      }
      return controlResultRejected("CONFLICT", "A different control result already uses this result_id.", false);
    }

    const inFlight = binding.inFlightResults.get(validated.payload.result_id);
    if (inFlight !== undefined) {
      return inFlight === fingerprint
        ? { kind: "already_present", result_id: validated.payload.result_id }
        : controlResultRejected("CONFLICT", "A different control result is already being appended for this result_id.", false);
    }
    if (binding.inFlightResults.size >= MAX_CONTROL_RESULT_IN_FLIGHT) {
      return controlResultRejected("RESULT_DELIVERY_FAILED", "The child has too many pending control-result appends.", true);
    }

    binding.inFlightResults.set(validated.payload.result_id, fingerprint);
    try {
      await binding.childSession.appendControlResult(validated.payload);
    } catch {
      if (binding.inFlightResults.get(validated.payload.result_id) === fingerprint) {
        binding.inFlightResults.delete(validated.payload.result_id);
      }
      return controlResultRejected("RESULT_DELIVERY_FAILED", "The child session did not accept the control result.", true);
    }
    // Pi resolves a streamed custom-message call when it queues the message, before
    // the child branch persists it. Keep the claim until the persisted branch confirms it.
    this.clearPersistedControlResultClaims(binding);
    return { kind: "accepted", result_id: validated.payload.result_id };
  }

  private createControlContext(record: Subagent): void {
    const ownerSessionId = record.lifecycleOwnerSessionId;
    const parentEntryId = record.lifecycleParentEntryId;
    const childSession = record.subagentSession;
    if (this.disposed || !record.isRunning() || !ownerSessionId || !parentEntryId || !childSession) return;
    this.invalidateControlContextForTask(record.id);
    const contextRef = `ctx1_${randomBytes(32).toString("base64url")}`;
    if (!isContextRefV1(contextRef)) throw new Error("Random child context reference did not match the V1 format.");
    const runId = record.getLifecycleRunV2().run_id;
    const binding: ControlContextBindingV1 = {
      contextRef,
      ownerSessionId,
      parentEntryId,
      taskId: record.id,
      runId,
      childSession,
      inFlightResults: new Map(),
      stopObservingPersistedResults: () => undefined,
    };
    binding.stopObservingPersistedResults = childSession.subscribe((event) => {
      if (event.type !== "message_end") return;
      // AgentSession notifies listeners immediately before its persistence finishes.
      // Defer this branch check so a streamed custom message has reached history first.
      queueMicrotask(() => this.clearPersistedControlResultClaims(binding));
    });
    this.controlContextsByRef.set(contextRef, binding);
    this.controlContextRefByTask.set(record.id, contextRef);
  }

  /** Release only claims whose matching result is now present on the exact child branch. */
  private clearPersistedControlResultClaims(binding: ControlContextBindingV1): void {
    if (this.getLiveControlContext(binding.contextRef) !== binding) return;
    for (const resultId of binding.inFlightResults.keys()) {
      if (binding.childSession.findControlResultById(resultId) !== undefined) {
        binding.inFlightResults.delete(resultId);
      }
    }
  }

  private getLiveControlContextRef(record: Subagent): ContextRefV1 | null {
    const contextRef = this.controlContextRefByTask.get(record.id);
    if (!contextRef) return null;
    const binding = this.getLiveControlContext(contextRef);
    return binding?.contextRef ?? null;
  }

  private getLiveControlContext(contextRef: ContextRefV1): ControlContextBindingV1 | undefined {
    if (!CONTEXT_REF_V1_PATTERN.test(contextRef)) return undefined;
    const binding = this.controlContextsByRef.get(contextRef);
    if (!binding || this.disposed || this.controlContextRefByTask.get(binding.taskId) !== contextRef) return undefined;
    const record = this.agents.get(binding.taskId);
    if (!record?.isRunning() || record.lifecycleOwnerSessionId !== binding.ownerSessionId
      || record.lifecycleParentEntryId !== binding.parentEntryId || record.subagentSession !== binding.childSession
      || record.getLifecycleRunV2().run_id !== binding.runId) return undefined;
    return binding;
  }

  private invalidateControlContextForTask(taskId: string): void {
    const contextRef = this.controlContextRefByTask.get(taskId);
    if (!contextRef) return;
    this.controlContextRefByTask.delete(taskId);
    const binding = this.controlContextsByRef.get(contextRef);
    binding?.stopObservingPersistedResults();
    this.controlContextsByRef.delete(contextRef);
  }

  private invalidateControlContext(record: Subagent): void {
    this.invalidateControlContextForTask(record.id);
  }

  private invalidateControlContextsForOwner(ownerSessionId: string): void {
    for (const [taskId, contextRef] of this.controlContextRefByTask) {
      if (this.controlContextsByRef.get(contextRef)?.ownerSessionId === ownerSessionId) {
        this.invalidateControlContextForTask(taskId);
      }
    }
  }

  private projectLifecycleV2Row(record: Subagent, sequence: number): SourceChildV2 {
    const parentEntryId = record.lifecycleParentEntryId;
    if (parentEntryId === undefined) {
      throw new Error("Cannot project lifecycle V2 source row without a persisted parent entry ID.");
    }
    const run = record.getLifecycleRunV2();
    return {
      ...run,
      model: run.model === null ? null : { ...run.model },
      compaction: { ...run.compaction },
      parent_entry_id: parentEntryId,
      description: record.description,
      lifecycle_state: record.status,
      sequence,
    };
  }

  private projectLifecycleV2ServiceRow(record: Subagent, sequence: number): LifecycleSnapshotV2ServiceRow {
    return {
      ...this.projectLifecycleV2Row(record, sequence),
      context_ref: this.getLiveControlContextRef(record),
    };
  }

  private assertLifecycleV2Owner(ownerSessionId: string): void {
    if (ownerSessionId.length === 0 || Buffer.byteLength(ownerSessionId, "utf8") > MAX_V2_STRING_UTF8_BYTES) {
      throw new Error("Lifecycle V2 owner session ID cannot form a bounded source envelope.");
    }
    const envelope: LifecycleSnapshotV2ServiceResult = {
      protocol: "mecha.children/v1",
      snapshot_id: LIFECYCLE_V2_SNAPSHOT_ID_PLACEHOLDER,
      owner_session_id: ownerSessionId,
      sequence: 0,
      runs: [],
    };
    if (
      countSnapshotNodes(envelope) > MAX_SNAPSHOT_NODES
      || Buffer.byteLength(JSON.stringify(envelope), "utf8") > MAX_SNAPSHOT_UTF8_BYTES
    ) {
      throw new Error("Lifecycle V2 owner session ID cannot form a bounded source envelope.");
    }
  }

  private assertLifecycleV2SnapshotBounds(snapshot: LifecycleSnapshotV2ServiceResult): void {
    if (snapshot.runs.length > MAX_SOURCE_CHILDREN_PER_SNAPSHOT) {
      throw new Error("Lifecycle V2 snapshot exceeded the source child limit.");
    }
    if (countSnapshotNodes(snapshot) > MAX_SNAPSHOT_NODES) {
      throw new Error("Lifecycle V2 snapshot exceeded the node limit.");
    }
    if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > MAX_SNAPSHOT_UTF8_BYTES) {
      throw new Error("Lifecycle V2 snapshot exceeded the UTF-8 byte limit.");
    }
  }

  private touchLifecycleV2Owner(entry: LifecycleV2SequenceRegistryEntry, registry: LifecycleV2SequenceRegistry): void {
    entry.lastTouched = ++registry.nextTouch;
  }

  private claimLifecycleV2Owner(
    ownerSessionId: string,
    advanceOnClaim: boolean,
    validateOwner = true,
  ): LifecycleV2SequenceRegistryEntry {
    if (validateOwner) this.assertLifecycleV2Owner(ownerSessionId);
    const registry = getLifecycleV2SequenceRegistry();
    const alreadyClaimed = this.lifecycleV2OwnerClaims.has(ownerSessionId);
    let entry = registry.entries.get(ownerSessionId);
    if (alreadyClaimed) {
      if (!entry) throw new Error("Lifecycle V2 owner claim was released unexpectedly.");
      return entry;
    }
    if (!entry) {
      if (registry.entries.size >= MAX_LIFECYCLE_V2_SEQUENCE_OWNERS) {
        let oldestUnclaimed: LifecycleV2SequenceRegistryEntry | undefined;
        for (const candidate of registry.entries.values()) {
          if (candidate.activeClaims > 0) continue;
          if (!oldestUnclaimed || candidate.lastTouched < oldestUnclaimed.lastTouched) oldestUnclaimed = candidate;
        }
        if (!oldestUnclaimed) {
          throw new Error("Lifecycle V2 sequence registry is full of claimed owners.");
        }
        registry.entries.delete(oldestUnclaimed.ownerSessionId);
      }
      entry = {
        ownerSessionId,
        lastSequence: 0,
        lastTouched: 0,
        activeClaims: 0,
      };
      registry.entries.set(ownerSessionId, entry);
    }
    entry.activeClaims++;
    this.lifecycleV2OwnerClaims.add(ownerSessionId);
    if (advanceOnClaim) entry.lastSequence++;
    this.touchLifecycleV2Owner(entry, registry);
    return entry;
  }

  private clearLifecycleV2RecordStates(ownerSessionId: string): void {
    for (const [id, state] of this.lifecycleV2RecordStates) {
      if (state.ownerSessionId === ownerSessionId) this.lifecycleV2RecordStates.delete(id);
    }
  }

  /** Keep source-projection failures from changing an existing subagent run. */
  private observeLifecycleV2Mutation(record: Subagent): void {
    try {
      this.noteLifecycleV2Mutation(record);
    } catch (err) {
      debugLog("lifecycle V2 manager mutation", err);
    }
  }

  /** Snapshot only public inline-extension capabilities for one child spawn. */
  private snapshotChildExtensionFactories(ownerSessionId: string | undefined): InlineExtension[] {
    if (ownerSessionId === undefined) return [];
    const factories = this.childExtensionFactoriesByOwner.get(ownerSessionId);
    if (factories === undefined) return [];
    return [...factories.entries()].map(([name, factory]) => ({ name, factory }));
  }

  /** Compose a per-agent lifecycle observer from manager and spawn-config concerns. */
  private buildObserver(options: AgentSpawnConfig): SubagentLifecycleObserver {
    return {
      onStarted: (agent) => {
        this.publishLifecycle(agent);
        this.observeLifecycleV2Mutation(agent);
        this.observer?.onSubagentStarted(agent);
      },
      onSessionCreated: (agent) => {
        try {
          options.observer?.onSessionCreated?.(agent);
        } finally {
          // The run and exact child session now exist, so this is the first point a reference can bind.
          this.createControlContext(agent);
          this.observeLifecycleV2Mutation(agent);
        }
      },
      onRunFinished: (agent) => {
        this.invalidateControlContext(agent);
        try { this.publishLifecycle(agent, true); } catch (err) {
          journalSubagentError("lifecycle_snapshot_observer", err, { agent_id: agent.id, kind: agent.type });
          debugLog("lifecycle snapshot observer", err);
        }
        this.observeLifecycleV2Mutation(agent);
        try { this.observer?.onSubagentCompleted(agent); } catch (err) {
          journalSubagentError("completed_observer", err, { agent_id: agent.id, kind: agent.type, status: agent.status });
          debugLog("onSubagentCompleted observer", err);
        }
      },
      onResumeStarted: (agent) => {
        // Resume replaces the run before this callback. The old binding must be dead before any new row publishes.
        this.invalidateControlContext(agent);
        this.createControlContext(agent);
        journalSubagentEvent("subagents.resume_started", {
          agent_id: agent.id,
          kind: agent.type,
          status: agent.status,
        });
        this.publishLifecycle(agent);
        this.observeLifecycleV2Mutation(agent);
      },
      onResumeFinished: (agent) => {
        this.invalidateControlContext(agent);
        try { this.publishLifecycle(agent, true); } catch (err) {
          journalSubagentError("lifecycle_snapshot_observer", err, { agent_id: agent.id, kind: agent.type });
          debugLog("lifecycle snapshot observer", err);
        }
        this.observeLifecycleV2Mutation(agent);
        try { this.observer?.onSubagentResumed(agent); } catch (err) {
          journalSubagentError("resumed_observer", err, { agent_id: agent.id, kind: agent.type, status: agent.status });
          debugLog("onSubagentResumed observer", err);
        }
      },
      onCompactionTransition: (agent) => {
        this.observeLifecycleV2Mutation(agent);
      },
      onCompacted: (agent, info) => {
        this.observer?.onSubagentCompacted(agent, info);
      },
    };
  }

  /**
   * Spawn an agent and return its ID immediately.
   * If the concurrency limit is reached, the agent is queued.
   */
  spawn(
    snapshot: ParentSnapshot,
    type: SubagentType,
    prompt: string,
    options: AgentSpawnConfig,
  ): string {
    const id = randomUUID().slice(0, 17);
    // Take the owner registration snapshot at spawn, before workspace preparation
    // or child loader construction can yield. Existing children remain stable when
    // a parent disposes or replaces a registration later.
    const childExtensionFactories = this.snapshotChildExtensionFactories(options.parentSession?.parentSessionId);
    const record = new Subagent({
      id,
      type,
      description: options.description,
      invocation: options.invocation,
      state: new SubagentState({
        status: "queued",
        startedAt: Date.now(),
      }),
      execution: {
        createSubagentSession: (params) => this.createSubagentSession({
          ...params,
          childExtensionFactories,
        }),
        snapshot,
        prompt,
        baseCwd: this.baseCwd,
        observer: this.buildObserver(options),
        getRunConfig: this.getRunConfig,
        getWorkspaceProvider: () => this._workspaceProvider,
        model: options.model,
        maxTurns: options.maxTurns,
        thinkingLevel: options.thinkingLevel,
        parentSession: options.parentSession,
        signal: options.signal,
      },
    });
    this.agents.set(id, record);

    this.publishLifecycle(record);
    this.observeLifecycleV2Mutation(record);
    this.observer?.onSubagentCreated(record);

    if (!options.bypassQueue) {
      journalSubagentEvent("subagents.queued", {
        agent_id: record.id,
        kind: record.type,
        status: record.status,
        state: "queued",
      });
      // Schedule on the limiter — scheduleVia captures the limiter promise
      // eagerly, so abort-while-queued settles cleanly when the slot frees.
      record.scheduleVia((thunk) => this.limiter.schedule(thunk));
      return id;
    }

    // Queue bypass changes admission only. start() records the asynchronous run,
    // while this method still returns the ID without awaiting child completion.
    record.start();
    return id;
  }

  /**
   * Resume an existing agent session with a new prompt.
   * Delegates to Subagent.resume(), which owns the observer subscription lifecycle.
   */
  async resume(
    id: string,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<Subagent | undefined> {
    const agent = this.agents.get(id);
    if (!agent?.isSessionReady()) return undefined;
    await agent.resume(prompt, signal);
    return agent;
  }

  getRecord(id: string): Subagent | undefined {
    return this.agents.get(id);
  }

  listAgents(): Subagent[] {
    return [...this.agents.values()].sort(
      (a, b) => b.startedAt - a.startedAt,
    );
  }

  abort(id: string): boolean {
    const record = this.agents.get(id);
    if (!record) return false;

    // A queued agent has not started; stop it through the same terminal funnel
    // a running agent's stop uses. Its scheduled thunk becomes a no-op (status
    // guard) when its slot finally opens.
    if (record.status === "queued") {
      record.stopQueued();
      return true;
    }

    const aborted = record.abort();
    if (aborted) {
      this.invalidateControlContext(record);
      this.observeLifecycleV2Mutation(record);
    }
    return aborted;
  }

  /** Dispose a record's session and remove it from the map. */
  private removeRecord(id: string, record: Subagent): void {
    this.invalidateControlContext(record);
    record.disposeSession();
    this.agents.delete(id);
    this.lifecycleV2RecordStates.delete(id);
  }

  /**
   * Release the heavy session of any terminal agent past its retention window.
   * The record (with its result) is retained for the session lifetime; only the
   * live `AgentSession` is freed. A consumed agent releases on the short window,
   * measured from the later of completion or consumption (so a late read still
   * gets a full resume window); an unconsumed agent holds until the long cap.
   */
  private sweep() {
    const policy = this.getRetentionPolicy?.() ?? DEFAULT_RETENTION_POLICY;
    const now = Date.now();
    for (const record of this.agents.values()) {
      if (record.isActive()) continue;
      if (!record.isSessionReady()) continue; // already released, or never had a session
      const referenceAt = record.consumed
        ? Math.max(record.completedAt ?? 0, record.consumedAt ?? 0)
        : record.completedAt ?? 0;
      const windowMinutes = record.consumed
        ? policy.consumedSessionRetentionMinutes
        : policy.unconsumedSessionRetentionMinutes;
      if (now - referenceAt >= windowMinutes * 60_000) record.releaseSession();
    }
  }

  /**
   * Remove all completed/stopped/errored records immediately.
   * Called on session start/switch so tasks from a prior session don't persist.
   */
  clearCompleted(): void {
    for (const [id, record] of this.agents) {
      if (record.isActive()) continue;
      this.removeRecord(id, record);
    }
  }

  /** Whether any agents are still running or queued. */
  hasRunning(): boolean {
    return [...this.agents.values()].some(r => r.isActive());
  }

  /** Abort all running and queued agents immediately. */
  abortAll(): number {
    let count = 0;
    for (const record of this.agents.values()) {
      if (record.status === "queued") {
        record.stopQueued();
        count++;
      } else if (record.abort()) {
        this.invalidateControlContext(record);
        this.observeLifecycleV2Mutation(record);
        count++;
      }
    }
    // Drop pending thunks (their promises resolve).
    this.limiter.clear();
    return count;
  }

  dispose(): void {
    if (this.disposed) return;
    // Fence delayed child completion and compaction callbacks before session disposal.
    this.disposed = true;
    clearInterval(this.sweepInterval);
    // Drop pending thunks.
    this.limiter.clear();
    for (const record of this.agents.values()) {
      this.invalidateControlContext(record);
      record.disposeSession();
    }
    // A direct manager disposal has no SDK shutdown event, so quit is the safe default.
    for (const ownerSessionId of [...this.lifecycleV2OwnerClaims]) {
      this.releaseLifecycleV2Owner(ownerSessionId, "quit");
    }
    this.agents.clear();
    this.lifecycleV2RecordStates.clear();
    this.controlContextsByRef.clear();
    this.controlContextRefByTask.clear();
    this.lifecycleV2Listeners.clear();
    this.childExtensionFactoriesByOwner.clear();
  }
}
