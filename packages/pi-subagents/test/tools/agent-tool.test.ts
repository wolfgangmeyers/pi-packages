import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { AgentTool } from "#src/tools/agent-tool";
import type { Subagent } from "#src/types";
import { createToolDeps, createToolDepsWithDisabledBuiltInAgents } from "#test/helpers/make-deps";
import { createTestSubagent } from "#test/helpers/make-subagent";
import { createMockSession, createSubagentSessionStub, toSubagentSession } from "#test/helpers/mock-session";

function makeCtx(overrides: Record<string, unknown> = {}) {
	return {
		ui: { fake: true },
		...overrides,
	} as unknown as ExtensionContext;
}

function makeTool(deps: ReturnType<typeof createToolDeps>) {
	deps.runtime.getToolParentSessionInfo ??= vi.fn((toolCallId: string) => Object.freeze({
			parentSessionFile: "/sessions/parent.jsonl",
			parentSessionId: "session-1",
			parentEntryId: "assistant-entry-1",
			toolCallId,
		}));
	return new AgentTool(deps.manager, deps.runtime, deps.settings, deps.registry, deps.agentDir);
}

async function execute(
	deps: ReturnType<typeof createToolDeps>,
	params: Record<string, unknown>,
	ctx?: ReturnType<typeof makeCtx>,
	signal: AbortSignal = new AbortController().signal,
) {
	return makeTool(deps).execute(
		"tc-1",
		params,
		signal,
		vi.fn(),
		ctx ?? makeCtx(),
	);
}

describe("AgentTool", () => {
	it("returns tool definition with correct name and label", () => {
		const def = makeTool(createToolDeps()).toToolDefinition();
		expect(def.name).toBe("subagent");
		expect(def.label).toBe("Subagent");
	});

	it("includes promptSnippet", () => {
		const def = makeTool(createToolDeps()).toToolDefinition();
		expect(def.promptSnippet).toBe(
			"subagent: Launch a specialized agent for complex, multi-step tasks.",
		);
	});

	it("exposes a strict background-only schema", () => {
		const def = makeTool(createToolDeps()).toToolDefinition();
		expect(def.parameters.additionalProperties).toBe(false);
		expect(def.parameters.properties).not.toHaveProperty("run_in_background");
		expect(def.description).toContain("Agents always run in the background");
	});

	it.each([
		[true, 'Unsupported argument "run_in_background": true. Background execution is always enabled.'],
		[false, 'Unsupported argument "run_in_background": false. Background execution is always enabled.'],
		["legacy", 'Unsupported argument "run_in_background": "legacy". Background execution is always enabled.'],
	])("rejects stale run_in_background=%j in prepareArguments", (value, message) => {
		const def = makeTool(createToolDeps()).toToolDefinition();
		expect(() => def.prepareArguments?.({
			prompt: "test",
			description: "test",
			subagent_type: "general-purpose",
			run_in_background: value,
		})).toThrow(message);
	});

	it("derives type list from registry", () => {
		const def = makeTool(createToolDeps()).toToolDefinition();
		expect(def.description).toContain("- general-purpose: General-purpose agent");
		expect(def.description).toContain("- Plan: Software architect for implementation planning");
	});

	it("lists the built-in agent guidelines in registry order", () => {
		const def = makeTool(createToolDeps()).toToolDefinition();
		const guidelines = [
			"- Use general-purpose for complex tasks that need file editing.",
			"- Use Plan for architecture and implementation planning.",
		];
		for (const line of guidelines) expect(def.description).toContain(line);
		const positions = guidelines.map((line) => def.description.indexOf(line));
		expect(positions).toEqual([...positions].sort((a, b) => a - b));
	});

	it.for(["Plan", "general-purpose"])(
		"omits the type-list entry and guideline for a disabled built-in %s",
		(name) => {
			const def = makeTool(createToolDepsWithDisabledBuiltInAgents(name)).toToolDefinition();
			expect(def.description).not.toContain(`- ${name}:`);
			expect(def.description).not.toContain(`- Use ${name} for `);
		},
	);

	it("calls registry.reload() on each execute", async () => {
		const deps = createToolDeps();
		const reloadSpy = vi.spyOn(deps.registry, "reload");
		await execute(deps, {
			prompt: "test",
			description: "test",
			subagent_type: "general-purpose",
		});
		expect(reloadSpy).toHaveBeenCalledOnce();
	});
});

describe("AgentTool — resume path", () => {
	it("returns not-found when resume ID does not exist", async () => {
		const deps = createToolDeps();
		deps.manager.getRecord = vi.fn().mockReturnValue(undefined);
		const result = await execute(deps, {
			prompt: "continue",
			description: "resume",
			subagent_type: "general-purpose",
			resume: "nonexistent",
		});
		expect(result.content[0].text).toContain("Agent not found");
		expect(result.content[0].text).not.toContain("cleaned up");
	});

	it("returns no-session when agent has no active session", async () => {
		const deps = createToolDeps();
		deps.manager.getRecord = vi.fn().mockReturnValue(createTestSubagent());
		const result = await execute(deps, {
			prompt: "continue",
			description: "resume",
			subagent_type: "general-purpose",
			resume: "agent-1",
		});
		expect(result.content[0].text).toContain("no active session");
	});

	it("points a released-agent resume at get_subagent_result", async () => {
		const deps = createToolDeps();
		const released = createTestSubagent();
		released.subagentSession = toSubagentSession(createSubagentSessionStub(createMockSession(), "/tasks/agent.jsonl"));
		released.releaseSession();
		deps.manager.getRecord = vi.fn().mockReturnValue(released);
		const result = await execute(deps, {
			prompt: "continue",
			description: "resume",
			subagent_type: "general-purpose",
			resume: "agent-1",
		});
		expect(result.content[0].text).toContain("get_subagent_result");
		expect(deps.manager.resume).not.toHaveBeenCalled();
	});

	it("returns immediately and resumes without the tool AbortSignal", async () => {
		const deps = createToolDeps();
		const resumeRecord = createTestSubagent();
		resumeRecord.subagentSession = toSubagentSession(createSubagentSessionStub(createMockSession()));
		deps.manager.getRecord = vi.fn().mockReturnValue(resumeRecord);
		const pendingResume = Promise.withResolvers<Subagent | undefined>();
		deps.manager.resume = vi.fn().mockReturnValue(pendingResume.promise);
		const toolSignal = new AbortController().signal;
		const resolveToolParentSession = vi.fn();
		deps.runtime.getToolParentSessionInfo = resolveToolParentSession;

		const result = await execute(deps, {
			prompt: "continue",
			description: "resume",
			subagent_type: "general-purpose",
			resume: "agent-1",
		}, undefined, toolSignal);

		expect(result.content[0].text).toBe('Resumed agent "agent-1" in the background.');
		expect(deps.manager.resume).toHaveBeenCalledExactlyOnceWith("agent-1", "continue");
		expect(resolveToolParentSession).not.toHaveBeenCalled();
		expect(resumeRecord.consumed).toBe(false);
	});
});

describe("AgentTool — model resolution error", () => {
	it("returns error when model resolution fails", async () => {
		const deps = createToolDeps();
		const result = await execute(deps, {
			prompt: "test",
			description: "test",
			subagent_type: "general-purpose",
			model: "nonexistent-model-xyz",
		});
		expect(result.content[0].text).toContain("nonexistent-model-xyz");
	});
});

describe("AgentTool — background execution", () => {
	it("returns background launch message with agent ID", async () => {
		const deps = createToolDeps();
		deps.manager.getRecord = vi.fn().mockReturnValue(createTestSubagent({ status: "running" }));
		const result = await execute(deps, {
			prompt: "do something",
			description: "bg task",
			subagent_type: "general-purpose",
		});
		const text = result.content[0].text;
		expect(text).toContain("background");
		expect(text).toContain("agent-1");
		expect(text).toContain("bg task");
	});

	it("binds a new spawn to the exact persisted assistant entry", async () => {
		const deps = createToolDeps();
		const parentSession = Object.freeze({
			parentSessionFile: "/sessions/parent.jsonl",
			parentSessionId: "session-1",
			parentEntryId: "assistant-entry-42",
			toolCallId: "tc-1",
		});
		const resolveToolParentSession = vi.fn(() => parentSession);
		deps.runtime.getToolParentSessionInfo = resolveToolParentSession;
		deps.manager.getRecord = vi.fn().mockReturnValue(createTestSubagent({ status: "running" }));

		await execute(deps, {
			prompt: "do something",
			description: "bg task",
			subagent_type: "general-purpose",
		});

		const spawnOpts = (deps.manager.spawn as ReturnType<typeof vi.fn>).mock.calls[0][3];
		expect(resolveToolParentSession).toHaveBeenCalledExactlyOnceWith("tc-1");
		expect(spawnOpts.parentSession).toBe(parentSession);
		expect(spawnOpts.parentSession).toEqual({
			parentSessionFile: "/sessions/parent.jsonl",
			parentSessionId: "session-1",
			parentEntryId: "assistant-entry-42",
			toolCallId: "tc-1",
		});
		expect(spawnOpts.parentSession.parentEntryId).not.toBe("tc-1");
		expect(Object.isFrozen(spawnOpts.parentSession)).toBe(true);
	});

	it("fails before manager mutation when no persisted assistant entry matches the tool call", async () => {
		const deps = createToolDeps();
		deps.runtime.getToolParentSessionInfo = vi.fn(() => {
			throw new Error("Cannot spawn a subagent without a matching persisted assistant entry for the current tool call.");
		});

		const result = await execute(deps, {
			prompt: "do something",
			description: "bg task",
			subagent_type: "general-purpose",
		});

		expect(result.content[0].text).toBe(
			"Cannot spawn a subagent without a matching persisted assistant entry for the current tool call.",
		);
		expect(deps.manager.spawn).not.toHaveBeenCalled();
	});

	it("checks the post-yield parent binding before snapshotting a spawn after session teardown", async () => {
		const deps = createToolDeps();
		const tool = makeTool(deps);
		const buildSnapshot = vi.fn(() => {
			throw new TypeError("Cannot read properties of undefined (reading 'sessionManager')");
		});
		const resolveParentAfterTeardown = vi.fn(() => {
			throw new Error("Cannot spawn a subagent without an active parent session.");
		});
		deps.runtime.buildSnapshot = buildSnapshot;

		const pendingResult = tool.execute(
			"tc-1",
			{
				prompt: "do something",
				description: "bg task",
				subagent_type: "general-purpose",
			},
			new AbortController().signal,
			vi.fn(),
			makeCtx(),
		);
		// execute yields once before reading the runtime. This replaces the
		// pre-yield binding with the result of clearing the source context.
		deps.runtime.getToolParentSessionInfo = resolveParentAfterTeardown;

		const result = await pendingResult;

		expect(result.content[0].text).toBe("Cannot spawn a subagent without an active parent session.");
		expect(resolveParentAfterTeardown).toHaveBeenCalledExactlyOnceWith("tc-1");
		expect(buildSnapshot).not.toHaveBeenCalled();
		expect(deps.manager.spawn).not.toHaveBeenCalled();
		expect(deps.manager.resume).not.toHaveBeenCalled();
		expect(deps.manager.getRecord).not.toHaveBeenCalled();
	});

	it("does not wire the tool-call AbortSignal into a fresh child", async () => {
		const deps = createToolDeps();
		deps.manager.getRecord = vi.fn().mockReturnValue(createTestSubagent({ status: "running" }));
		const toolController = new AbortController();
		toolController.abort();

		await execute(deps, {
			prompt: "do something",
			description: "bg task",
			subagent_type: "general-purpose",
		}, undefined, toolController.signal);

		expect(deps.manager.spawn).toHaveBeenCalledOnce();
		const spawnOpts = (deps.manager.spawn as ReturnType<typeof vi.fn>).mock.calls[0][3];
		expect(spawnOpts).not.toHaveProperty("signal");
	});
});
