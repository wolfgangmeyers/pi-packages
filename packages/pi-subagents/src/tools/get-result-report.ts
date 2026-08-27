/**
 * get-result-report.ts — Pure report assembly for get_subagent_result.
 *
 * All functions are stateless: they receive an AgentReport, returning
 * formatted strings. No SDK types, no timers, no side effects.
 * Consumed by GetResultTool.execute in get-result-tool.ts. Mirrors the
 * result-renderer.ts pattern used by the subagent tool's TUI renderer.
 */

import type { SubagentStatus } from "#src/lifecycle/subagent";

/** Shared model guidance for every incomplete result retrieval path. */
export const RUNNING_RESULT_GUIDANCE =
	"**MANDATORY**!!! This is a snapshot only. Do NOT repeatedly pull a running result!!! The full context must be sent back to the model on every call, so repeated pulls burn tokens very quickly. Rest and wait for completion; a completion notification will arrive automatically. Checking early is appropriate only when you were explicitly told to check early.";

/** The data a get_subagent_result report renders from — only what the formatter reads. */
export interface AgentReport {
	id: string;
	displayName: string;
	status: SubagentStatus;
	toolUses: number;
	/** Pre-formatted lifetime token total; "" when zero. */
	tokens: string;
	contextPercent: number | null;
	compactionCount: number;
	/** Pre-formatted duration string. */
	duration: string;
	description: string;
	result: string | undefined;
	error: string | undefined;
	/** Whether the agent was stopped before the limiter ever admitted it. */
	stoppedWhileQueued: boolean;
	/** Present only when verbose was requested and a conversation is available. */
	conversation?: string;
	/** Persisted transcript path; rendered as a pointer so the parent can read it directly. */
	transcriptPath?: string;
}

/** Assemble the stats parts: Tool uses / tokens? / Context? / Compactions? / Duration. */
export function renderStatsParts(report: AgentReport): string[] {
	const parts = [`Tool uses: ${report.toolUses}`];
	if (report.tokens) parts.push(report.tokens);
	if (report.contextPercent !== null) parts.push(`Context: ${Math.round(report.contextPercent)}%`);
	if (report.compactionCount) parts.push(`Compactions: ${report.compactionCount}`);
	parts.push(`Duration: ${report.duration}`);
	return parts;
}

/** Select the per-status body: running note, error line, or trimmed result. */
export function renderReportBody(report: AgentReport): string {
	if (report.status === "running") return RUNNING_RESULT_GUIDANCE;
	if (report.status === "error") return `Error: ${report.error}`;
	if (report.stoppedWhileQueued)
		return "Agent was stopped while queued and never started. No work was performed.";
	return report.result?.trim() ?? "No output.";
}

/** Assemble the full get_subagent_result report text. */
export function formatAgentReport(report: AgentReport): string {
	let output =
		`Agent: ${report.id}\n` +
		`Type: ${report.displayName} | Status: ${report.status} | ${renderStatsParts(report).join(" | ")}\n` +
		`Description: ${report.description}\n\n`;
	output += renderReportBody(report);
	if (report.conversation) {
		output += `\n\n--- Agent Conversation ---\n${report.conversation}`;
	}
	if (report.transcriptPath) {
		output += `\n\nFull transcript available at: ${report.transcriptPath}`;
	}
	return output;
}
