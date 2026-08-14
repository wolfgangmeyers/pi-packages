import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { AgentConfigLookup } from "#src/config/agent-types";
import {
	type AgentReport,
	formatAgentReport,
	renderStatsParts,
} from "#src/tools/get-result-report";
import { formatLifetimeTokens, textResult } from "#src/tools/helpers";
import type { Subagent } from "#src/types";
import { formatDuration, getDisplayName } from "#src/ui/display";

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

	execute(
		_toolCallId: string,
		params: { agent_id: string; verbose?: boolean },
		_signal: AbortSignal,
		_onUpdate: unknown,
		_ctx: unknown,
	) {
		const record = this.manager.getRecord(params.agent_id);
		if (!record) {
			return Promise.resolve(
				textResult(`Agent not found: "${params.agent_id}". Records are cleared at session start/switch, so it may be from a previous session.`),
			);
		}

		const report = this.buildReport(record, params.verbose);
		return Promise.resolve(
			textResult(
				report.status === "running"
					? formatRunningAgentReport(report)
					: formatAgentReport(report),
			),
		);
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
		const parameters = Type.Object(
			{
				agent_id: Type.String({
					description: "The agent ID to check.",
				}),
				verbose: Type.Optional(
					Type.Boolean({
						description:
							"If true, include the agent's full conversation (messages + tool calls). Default: false.",
					}),
				),
			},
			{ additionalProperties: false },
		);

		return defineTool({
			name: "get_subagent_result" as const,
			label: "Get Agent Result",
			promptSnippet:
				"get_subagent_result: Get a nonblocking snapshot. Running agents notify automatically, so polling wastes work and tokens.",
			description:
				"Get a nonblocking status/result snapshot for a background agent. Running agents notify automatically when they finish; do not poll because polling wastes work and tokens. Continue other work instead.",
			prepareArguments: (args: unknown) => {
				if (args && typeof args === "object" && "wait" in args) {
					const value = args.wait;
					throw new Error(
						`Unsupported argument "wait": ${JSON.stringify(value)}. Result retrieval is snapshot-only; running agents notify automatically.`,
					);
				}
				Value.Assert(parameters, args);
				return args;
			},
			parameters,
			execute: (
				toolCallId: string,
				params: { agent_id: string; verbose?: boolean },
				signal: AbortSignal,
				onUpdate: unknown,
				ctx: unknown,
			) => this.execute(toolCallId, params, signal, onUpdate, ctx),
		});
	}
}

function formatRunningAgentReport(report: AgentReport): string {
	let output =
		`Agent: ${report.id}\n` +
		`Type: ${report.displayName} | Status: ${report.status} | ${renderStatsParts(report).join(" | ")}\n` +
		`Description: ${report.description}\n\n` +
		"Do not poll. Continue other work; you will be notified when this subagent finishes.";
	if (report.conversation) {
		output += `\n\n--- Agent Conversation ---\n${report.conversation}`;
	}
	if (report.transcriptPath) {
		output += `\n\nFull transcript available at: ${report.transcriptPath}`;
	}
	return output;
}
