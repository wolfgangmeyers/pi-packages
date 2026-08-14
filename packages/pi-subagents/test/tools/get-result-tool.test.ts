import { describe, expect, it } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import { GetResultTool, type GetResultToolManager } from "#src/tools/get-result-tool";
import type { Subagent } from "#src/types";
import { createTestSubagent } from "#test/helpers/make-subagent";
import { createMockSession, createSubagentSessionStub, toSubagentSession } from "#test/helpers/mock-session";
import { STUB_CTX } from "#test/helpers/stub-ctx";

const RUNNING_HINT = "Do not poll. Continue other work; you will be notified when this subagent finishes.";
const testRegistry = new AgentTypeRegistry(() => new Map());

function makeManager(records: Map<string, Subagent> = new Map()): GetResultToolManager {
	return { getRecord: (id: string) => records.get(id) };
}

async function execute(
	manager: GetResultToolManager,
	params: { agent_id: string; verbose?: boolean },
	signal: AbortSignal = new AbortController().signal,
) {
	const tool = new GetResultTool(manager, testRegistry);
	return tool.execute("tc-1", params, signal, undefined, STUB_CTX);
}

describe("GetResultTool — public dispatch contract", () => {
	it("returns the snapshot-only tool definition", () => {
		const def = new GetResultTool(makeManager(), testRegistry).toToolDefinition();
		expect(def.name).toBe("get_subagent_result");
		expect(def.promptSnippet).toBe(
			"get_subagent_result: Get a nonblocking snapshot. Running agents notify automatically, so polling wastes work and tokens.",
		);
		expect(def.description).toContain("Continue other work instead.");
		expect(def.parameters.additionalProperties).toBe(false);
		expect(def.parameters.properties).not.toHaveProperty("wait");
	});

	it.each([
		[true, 'Unsupported argument "wait": true. Result retrieval is snapshot-only; running agents notify automatically.'],
		[false, 'Unsupported argument "wait": false. Result retrieval is snapshot-only; running agents notify automatically.'],
		["later", 'Unsupported argument "wait": "later". Result retrieval is snapshot-only; running agents notify automatically.'],
	])("rejects stale wait=%j in prepareArguments", (value, message) => {
		const def = new GetResultTool(makeManager(), testRegistry).toToolDefinition();
		expect(() => def.prepareArguments?.({ agent_id: "agent-1", wait: value })).toThrow(message);
	});
});

describe("GetResultTool — nonblocking snapshots", () => {
	it("returns not-found copy for an unknown agent", async () => {
		const result = await execute(makeManager(), { agent_id: "unknown" });
		expect(result.content[0].text).toContain("Agent not found");
		expect(result.content[0].text).not.toContain(RUNNING_HINT);
	});

	it("returns the current completed result without consuming it", async () => {
		const record = createTestSubagent({ toolCallId: "tc-1" });
		const manager = makeManager(new Map([["agent-1", record]]));
		const first = await execute(manager, { agent_id: "agent-1" });
		const second = await execute(manager, { agent_id: "agent-1" });

		expect(first.content[0].text).toContain("Status: completed");
		expect(first.content[0].text).toContain("All done.");
		expect(second.content[0].text).toBe(first.content[0].text);
		expect(record.consumed).toBe(false);
		expect(manager.getRecord("agent-1")).toBe(record);
	});

	it("returns repeated failed and cancelled snapshots without consuming them", async () => {
		for (const status of ["error", "stopped"] as const) {
			const record = createTestSubagent({ status, error: status === "error" ? "timeout" : undefined });
			const manager = makeManager(new Map([["agent-1", record]]));
			const first = await execute(manager, { agent_id: "agent-1" });
			const second = await execute(manager, { agent_id: "agent-1" });

			expect(second.content[0].text).toBe(first.content[0].text);
			expect(record.consumed).toBe(false);
			expect(manager.getRecord("agent-1")).toBe(record);
		}
	});

	it("returns a running snapshot with the exact anti-poll hint", async () => {
		const record = createTestSubagent({ status: "running", completedAt: undefined });
		const result = await execute(makeManager(new Map([["agent-1", record]])), {
			agent_id: "agent-1",
		});
		const text = result.content[0].text;
		expect(text).toContain("Status: running");
		expect(text.endsWith(`\n\n${RUNNING_HINT}`)).toBe(true);
		expect(text.split(RUNNING_HINT)).toHaveLength(2);
		expect(text.toLowerCase()).not.toContain("check back");
		expect(record.consumed).toBe(false);
	});

	it("reports a queued snapshot without consuming it", async () => {
		const record = createTestSubagent({ status: "queued", completedAt: undefined });
		const result = await execute(makeManager(new Map([["agent-1", record]])), {
			agent_id: "agent-1",
		});
		expect(result.content[0].text).toContain("Status: queued");
		expect(result.content[0].text).not.toContain(RUNNING_HINT);
		expect(record.consumed).toBe(false);
	});
});

describe("GetResultTool — verbose snapshots", () => {
	it("includes conversation when verbose=true", async () => {
		const record = createTestSubagent();
		const stub = createSubagentSessionStub();
		stub.getConversation.mockReturnValue("[User]: hello");
		record.subagentSession = toSubagentSession(stub);
		const result = await execute(makeManager(new Map([["agent-1", record]])), {
			agent_id: "agent-1",
			verbose: true,
		});
		expect(result.content[0].text).toContain("--- Agent Conversation ---");
		expect(result.content[0].text).toContain("[User]: hello");
	});

	it("points to the transcript when the live session was released", async () => {
		const record = createTestSubagent();
		record.subagentSession = toSubagentSession(
			createSubagentSessionStub(createMockSession(), "/tasks/agent.jsonl"),
		);
		record.releaseSession();
		const result = await execute(makeManager(new Map([["agent-1", record]])), {
			agent_id: "agent-1",
			verbose: true,
		});
		expect(result.content[0].text).toContain("Full transcript available at: /tasks/agent.jsonl");
		expect(result.content[0].text).not.toContain("--- Agent Conversation ---");
	});
});
