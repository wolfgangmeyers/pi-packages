/**
 * types.ts — Type definitions for the subagent system.
 */

import type { Model, ThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentSessionEvent, SessionContext as SdkSessionContext } from "@earendil-works/pi-coding-agent";
import type { ModelRegistry } from "#src/session/model-resolver";


export type { SteerOutcome } from "#src/lifecycle/subagent";
export { Subagent } from "#src/lifecycle/subagent";
export type { AgentSessionEvent, ThinkingLevel };

/**
 * One message in a child session's history, typed from Pi's `SessionContext`.
 *
 * Derived from the barrel-exported `SessionContext` (whose `messages` field is
 * `AgentMessage[]`) so the package needs no direct dependency on
 * `@earendil-works/pi-agent-core`, which is not re-exported from the public barrel.
 */
export type SessionMessage = SdkSessionContext["messages"][number];

/**
 * Narrow session interface for event subscription.
 * Used by record-observer — only the subscribe method is needed.
 */
export interface SubscribableSession {
  subscribe(fn: (event: AgentSessionEvent) => void): () => void;
}

/** Agent type: any string name (built-in defaults or user-defined). */
export type SubagentType = string;

/** UI display and agent listing — name, display name, description, prompt mode. */
export interface AgentIdentity {
  name: string;
  displayName?: string;
  description: string;
  promptMode: "replace" | "append";
}

/** Prompt assembly — name, prompt mode, system prompt. */
export interface AgentPromptConfig {
  name: string;
  promptMode: "replace" | "append";
  systemPrompt: string;
}

/** Unified agent configuration — used for both default and user-defined agents. */
export interface AgentConfig extends AgentIdentity, AgentPromptConfig {
  builtinToolNames?: string[];
  model?: string;
  thinking?: ThinkingLevel;
  maxTurns?: number;
  /** Default for spawn: fork parent conversation. undefined = caller decides. */
  inheritContext?: boolean;
  /** One-line usage guideline for the subagent tool's Guidelines: block. Omitted — no guideline line. */
  toolGuideline?: string;
  /** true = this is an embedded default agent (informational) */
  isDefault?: boolean;
  /** false = agent is hidden from the registry */
  enabled?: boolean;
  /** Where this agent was loaded from */
  source?: "default" | "project" | "global";
}

export interface AgentInvocation {
  /** Short display name, e.g. "haiku" — only set when different from parent. */
  modelName?: string;
  thinking?: ThinkingLevel;
  maxTurns?: number;
  inheritContext?: boolean;
}

/**
 * Narrow shell-exec callback replacing `ExtensionAPI` in `detectEnv()`.
 * Matches the shape of `pi.exec()` without carrying an SDK dependency.
 */
/**
 * Narrow interface capturing the ExtensionContext fields SubagentRuntime needs.
 * Avoids coupling runtime to the full SDK ExtensionContext surface (ISP).
 */
export interface SessionContext {
  readonly cwd: string;
  readonly model: Model<any> | undefined;
  readonly modelRegistry: ModelRegistry;
  getSystemPrompt(): string;
  readonly sessionManager: {
    getSessionFile(): string | undefined;
    getSessionId(): string;
    /** Read the active branch leaf ID for source-backed direct-service identity. */
    getLeafId?(): string | null;
    getBranch(): unknown[];
    /** Read the active branch leaf when a tool needs source-backed entry identity. */
    getLeafEntry?(): unknown;
    /** Read a parent entry while walking the active branch. */
    getEntry?(id: string): unknown;
  };
}

/**
 * Narrow shell-exec callback replacing `ExtensionAPI` in `detectEnv()`.
 * Matches the shape of `pi.exec()` without carrying an SDK dependency.
 */
export type ShellExec = (
  command: string,
  args: string[],
  options?: { cwd?: string; timeout?: number },
) => Promise<{ stdout: string; stderr: string; code: number }>;

/** Parent session identity — grouped fields that travel together from the tool boundary. */
export interface ParentSessionInfo {
	/** Path to the parent session's JSONL file (for deriving the subagent session directory). */
	readonly parentSessionFile?: string;
	/** Session ID of the parent agent (stored in the child session's parentSession header). */
	readonly parentSessionId?: string;
	/** Persisted parent-session entry containing the tool call that created this child. */
	readonly parentEntryId?: string;
	/** Tool call ID for background notification wiring. Exposed on the record via Subagent.toolCallId. */
	readonly toolCallId?: string;
}

/** Source-backed model identity for the lifecycle V2 wire format. */
export interface SourceModelV2 {
	provider: string;
	id: string;
	name: string;
}

/** Lifecycle states emitted by the source package. */
export type SourceLifecycleStateV2 =
	| "queued"
	| "running"
	| "completed"
	| "steered"
	| "aborted"
	| "stopped"
	| "error";

/** Per-execution compaction state emitted by the source package. */
export interface SourceCompactionV2 {
	state: "idle" | "compacting";
	count: number;
	started_at: string | null;
	last_outcome: "completed" | "failed" | "aborted" | null;
}

/** Current execution fields used to compose a lifecycle V2 source child. */
export interface SubagentLifecycleRunV2 {
	task_id: string;
	run_id: string;
	model: SourceModelV2 | null;
	started_at: string;
	finished_at: string | null;
	duration_ms: number | null;
	compaction: SourceCompactionV2;
}

/** Complete source-backed child row for a later lifecycle V2 snapshot. */
export interface SourceChildV2 extends SubagentLifecycleRunV2 {
	parent_entry_id: string;
	description: string;
	lifecycle_state: SourceLifecycleStateV2;
	sequence: number;
}

/** An opaque, manager-local live-child binding. It is never a router wire field. */
export type ContextRefV1 = `ctx1_${string}`;

/** JSON values allowed inside bounded control-result details. */
export type BoundedJsonValueV1 = null | boolean | number | string | BoundedJsonObjectV1 | BoundedJsonValueV1[];
export interface BoundedJsonObjectV1 {
	[key: string]: BoundedJsonValueV1;
}

/** A closed control completion sent from the router path to an exact child session. */
export interface ControlResultPayloadV1 {
	protocol: "mecha.control/v1";
	result_id: string;
	request_id: string;
	target_session_epoch: number;
	runtime_generation: string;
	manifest_sha256: string;
	status: "ok" | "error";
	content: string;
	details: BoundedJsonObjectV1;
	error?: {
		code: string;
		message: string;
		retryable: boolean;
	};
}

export type ControlResultAppendErrorCodeV1 =
	| "INVALID_ENVELOPE"
	| "PAYLOAD_TOO_LARGE"
	| "STALE_CHILD_CONTEXT"
	| "CONFLICT"
	| "RESULT_DELIVERY_FAILED";

export type ControlResultAppendOutcomeV1 =
	| { kind: "accepted"; result_id: string }
	| { kind: "already_present"; result_id: string }
	| {
		kind: "rejected";
		error: { code: ControlResultAppendErrorCodeV1; message: string; retryable: boolean };
	};

/** Service-only V2 row. Router snapshots keep using SourceChildV2 without context_ref. */
export interface LifecycleSnapshotV2ServiceRow extends SourceChildV2 {
	context_ref: ContextRefV1 | null;
}

/** Full router-safe source snapshot envelope for lifecycle V2. */
export interface SubagentLifecycleSnapshotV2 {
	protocol: "mecha.children/v1";
	snapshot_id: string;
	owner_session_id: string;
	sequence: number;
	runs: SourceChildV2[];
}

/** Augmented in-process service snapshot. It must be stripped before router delivery. */
export interface LifecycleSnapshotV2ServiceResult extends Omit<SubagentLifecycleSnapshotV2, "runs"> {
	runs: LifecycleSnapshotV2ServiceRow[];
}

/** In-process source delta. context_ref is service-only and not a mutable router field. */
export interface SubagentLifecycleDeltaV2 {
	protocol: "mecha.children/v1";
	owner_session_id: string;
	sequence: number;
	task_id: string;
	run_id: string;
	parent_entry_id: string;
	context_ref: ContextRefV1 | null;
	changes: Partial<Pick<SourceChildV2, "description" | "model" | "lifecycle_state" | "started_at" | "finished_at" | "duration_ms" | "compaction">>;
}

/** Explicit source compaction transition. */
export type CompactionTransitionV2 =
	| { type: "start"; started_at: string }
	| { type: "completed" }
	| { type: "failed" }
	| { type: "aborted" };

/** Compaction event info passed through lifecycle observers. */
export type CompactionInfo = { reason: "manual" | "threshold" | "overflow"; tokensBefore: number };
