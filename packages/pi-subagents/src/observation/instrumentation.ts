/**
 * Best-effort bridge to Mecha's process-global instrumentation journal.
 *
 * Mecha owns the journal, including storage, retention, and delivery. This
 * package only discovers the published version-one data property and submits
 * bounded, body-free records when it is present.
 */

const JOURNAL_VERSION = 1;
const MAX_DIAGNOSTIC_TOKEN_LENGTH = 128;
const MAX_ERROR_CODE_LENGTH = 64;

const JOURNAL_EVENTS = new Set([
  "subagents.created",
  "subagents.queued",
  "subagents.running",
  "subagents.terminal",
  "subagents.resume_started",
  "subagents.resume_terminal",
  "subagents.compacted",
  "subagents.steered",
  "subagents.error",
  "subagents.child.spawning",
  "subagents.child.session_created",
  "subagents.child.completed",
  "subagents.child.disposed",
  "subagents.child.session_linked",
  "subagents.snapshot_capped",
  "subagents.snapshot_evicted",
  "subagents.snapshot_normalized",
]);

const ERROR_NAMES = new Set([
  "AggregateError",
  "AbortError",
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
]);

const LIFECYCLE_STATUSES = new Set([
  "aborted",
  "background",
  "completed",
  "error",
  "queued",
  "running",
  "steered",
  "stopped",
]);
const LIFECYCLE_STATES = new Set(["queued", "running"]);

/** The process-global data property published by Mecha. */
export const MECHA_JOURNAL_DATA_PROPERTY = Symbol.for("mecha.pi.diagnostic-journal.v1");

/** Fixed fields accepted by Mecha's diagnostic journal. */
export interface SubagentJournalFields {
  agent_id?: string;
  component?: string;
  kind?: string;
  session_id?: string;
  parent_session_id?: string;
  status?: string;
  error_name?: string;
  error_code?: string;
  phase?: string;
  state?: string;
  disposition?: string;
  snapshot_count?: number;
  subagent_count?: number;
  available?: boolean;
  changed?: boolean;
}

/** The versioned process-global contract implemented by Mecha. */
export interface MechaDiagnosticJournalV1 {
  version: typeof JOURNAL_VERSION;
  record: (source: "pi-subagents", event: string, fields?: SubagentJournalFields) => boolean;
}

/** Submit one bounded record without allowing observability to affect behavior. */
export function journalSubagentEvent(
  event: string,
  fields: SubagentJournalFields = {},
): void {
  try {
    const normalizedEvent = event.replaceAll(":", ".");
    if (!JOURNAL_EVENTS.has(normalizedEvent)) return;
    const journal = findJournal();
    if (journal === undefined) return;
    journal.record("pi-subagents", normalizedEvent, copySafeFields(fields));
  } catch {
    // Mecha owns journal failure handling. Instrumentation never changes a run.
  }
}

/** Submit a caught error with its name and bounded context, never its message/body. */
export function journalSubagentError(
  context: string,
  error: unknown,
  fields: SubagentJournalFields = {},
): void {
  try {
    const code = errorCode(error);
    journalSubagentEvent("subagents.error", {
      ...copySafeFields(fields),
      error_name: errorName(error),
      ...(code === undefined ? {} : { error_code: code }),
      phase: context,
    });
  } catch {
    // Instrumentation never changes the behavior of the caught error path.
  }
}

function findJournal(): MechaDiagnosticJournalV1 | undefined {
  const value = readDataProperty(globalThis, MECHA_JOURNAL_DATA_PROPERTY);
  return isJournal(value) ? value : undefined;
}

function readDataProperty(target: object, key: PropertyKey): unknown {
  try {
    return Object.getOwnPropertyDescriptor(target, key)?.value;
  } catch {
    return undefined;
  }
}

function isJournal(value: unknown): value is MechaDiagnosticJournalV1 {
  try {
    if (value === null || typeof value !== "object") return false;
    return readDataProperty(value, "version") === JOURNAL_VERSION
      && typeof readDataProperty(value, "record") === "function";
  } catch {
    return false;
  }
}

function copySafeFields(fields: SubagentJournalFields): SubagentJournalFields {
  return {
    ...safeStringField(fields.agent_id, "agent_id"),
    ...safeStringField(fields.component, "component"),
    ...safeStringField(fields.kind, "kind"),
    ...safeStringField(fields.session_id, "session_id"),
    ...safeStringField(fields.parent_session_id, "parent_session_id"),
    ...safeStringField(fields.status, "status"),
    ...safeStringField(fields.error_name, "error_name"),
    ...safeStringField(fields.error_code, "error_code"),
    ...safeStringField(fields.phase, "phase"),
    ...safeStringField(fields.state, "state"),
    ...safeStringField(fields.disposition, "disposition"),
    ...safeCountField(fields.snapshot_count, "snapshot_count"),
    ...safeCountField(fields.subagent_count, "subagent_count"),
    ...(typeof fields.available === "boolean" ? { available: fields.available } : {}),
    ...(typeof fields.changed === "boolean" ? { changed: fields.changed } : {}),
  };
}

function safeStringField(
  value: string | undefined,
  field: keyof SubagentJournalFields,
): Partial<SubagentJournalFields> {
  if (typeof value !== "string") return {};

  const valid = field === "status"
    ? LIFECYCLE_STATUSES.has(value)
    : field === "state"
      ? LIFECYCLE_STATES.has(value)
      : field === "error_name"
        ? ERROR_NAMES.has(value)
        : field === "error_code"
          ? isDiagnosticToken(value, MAX_ERROR_CODE_LENGTH)
          : isDiagnosticToken(value, MAX_DIAGNOSTIC_TOKEN_LENGTH);
  return valid ? { [field]: value } : {};
}

function safeCountField(
  value: number | undefined,
  field: "snapshot_count" | "subagent_count",
): Partial<SubagentJournalFields> {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return {};
  return { [field]: value };
}

/** Diagnostic strings are identifiers, not a second channel for user content. */
function isDiagnosticToken(value: string, maxLength: number): boolean {
  return value.length > 0
    && value.length <= maxLength
    && /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value);
}

function errorCode(error: unknown): string | undefined {
  try {
    if (error !== null && typeof error === "object") {
      const code = readDataProperty(error, "code");
      if (typeof code === "string" && isDiagnosticToken(code, MAX_ERROR_CODE_LENGTH)) return code;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function errorName(error: unknown): string {
  try {
    const name = error instanceof Error
      ? error.name
      : error !== null && typeof error === "object"
        ? readDataProperty(error, "name")
        : undefined;
    return typeof name === "string" && ERROR_NAMES.has(name) ? name : "Error";
  } catch {
    return "Error";
  }
}
