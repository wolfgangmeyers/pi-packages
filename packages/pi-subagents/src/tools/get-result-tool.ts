import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { AgentConfigLookup } from "#src/config/agent-types";
import { type AgentReport, formatAgentReport } from "#src/tools/get-result-report";
import { formatLifetimeTokens, textResult } from "#src/tools/helpers";
import type { Subagent } from "#src/types";
import { formatDuration, getDisplayName } from "#src/ui/display";

const RESULT_WAIT_TIMEOUT_MS = 5_000;
const RESULT_WAIT_TIMEOUT_MESSAGE =
	"Timed out waiting for subagent result: blocking indefinitely on result retrieval is not allowed.";
type ResultWaitOutcome = "settled" | "aborted" | "timedOut";

// ---- Deps interfaces ----

export interface GetResultToolManager {
	getRecord(id: string): Subagent | undefined;
}

// ---- Class ----

export class GetResultTool {
	constructor(
		private readonly manager: GetResultToolManager,
		private readonly registry: AgentConfigLookup,
	) {}

	async execute(
		_toolCallId: string,
		params: { agent_id: string; wait?: boolean; verbose?: boolean },
		signal: AbortSignal,
		_onUpdate: unknown,
		_ctx: unknown,
	) {
		const record = this.manager.getRecord(params.agent_id);
		if (!record) {
			return textResult(`Agent not found: "${params.agent_id}". Records are cleared at session start/switch, so it may be from a previous session.`);
		}

		// Wait for completion if requested. A queued agent is awaitable because
		// scheduleVia() captures its limiter promise at spawn. The local race only
		// ends this query; neither parent abort nor timeout cancels the child.
		if (params.wait) {
			const waitOutcome = await this.waitForResult(record, signal);
			if (waitOutcome === "timedOut") {
				return {
					content: [{ type: "text" as const, text: RESULT_WAIT_TIMEOUT_MESSAGE }],
					details: undefined,
					isError: true as const,
				};
			}
		}

		// Pull-delivery edge: the parent is collecting the settled outcome here, so
		// mark it consumed. The completion nudge scheduled by onSubagentCompleted
		// re-reads record.consumed at fire time and suppresses itself.
		if (!record.isActive()) {
			record.markConsumed();
		}

		return textResult(formatAgentReport(this.buildReport(record, params.verbose)));
	}

	private async waitForResult(record: Subagent, signal: AbortSignal): Promise<ResultWaitOutcome> {
		const run = record.promise;
		if (!run || !record.isActive()) return "settled";
		if (signal.aborted) return "aborted";

		return new Promise<ResultWaitOutcome>((resolve) => {
			let resolved = false;

			const finish = (outcome: ResultWaitOutcome): void => {
				if (resolved) return;
				resolved = true;
				clearTimeout(timeout);
				signal.removeEventListener("abort", onAbort);
				resolve(outcome);
			};
			const onAbort = (): void => finish("aborted");

			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) {
				finish("aborted");
				return;
			}

			void run.then(
				() => finish("settled"),
				() => finish("settled"),
			);
			const timeout = setTimeout(() => finish("timedOut"), RESULT_WAIT_TIMEOUT_MS);
		});
	}

	private buildReport(record: Subagent, verbose?: boolean): AgentReport {
		return {
			id: record.id,
			displayName: getDisplayName(record.type, this.registry),
			status: record.status,
			toolUses: record.toolUses,
			tokens: formatLifetimeTokens(record),
			contextPercent: record.getContextPercent(),
			compactionCount: record.compactionCount,
			duration: formatDuration(record.startedAt, record.completedAt),
			description: record.description,
			result: record.result,
			error: record.error,
			stoppedWhileQueued: record.stoppedWhileQueued,
			conversation: verbose ? record.getConversation() : undefined,
			// Transcript pointer: lets the parent read the full session from disk,
			// and covers verbose after the live session was released (no conversation).
			transcriptPath: record.outputFile,
		};
	}

	toToolDefinition() {
		return defineTool({
			name: "get_subagent_result" as const,
			label: "Get Agent Result",
			promptSnippet:
				"get_subagent_result: Check status and retrieve results from a background agent.",
			description:
				"Check status and retrieve results from a background agent. Use the agent ID returned by Agent with run_in_background.",
			parameters: Type.Object({
				agent_id: Type.String({
					description: "The agent ID to check.",
				}),
				wait: Type.Optional(
					Type.Boolean({
						description:
							"If true, wait for the agent to complete before returning. Default: false.",
					}),
				),
				verbose: Type.Optional(
					Type.Boolean({
						description:
							"If true, include the agent's full conversation (messages + tool calls). Default: false.",
					}),
				),
			}),
			execute: (
				toolCallId: string,
				params: { agent_id: string; wait?: boolean; verbose?: boolean },
				signal: AbortSignal,
				onUpdate: unknown,
				ctx: unknown,
			) => this.execute(toolCallId, params, signal, onUpdate, ctx),
		});
	}
}
