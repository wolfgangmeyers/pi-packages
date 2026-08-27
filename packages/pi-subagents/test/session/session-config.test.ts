import type { Model } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { AgentConfigLookup } from "#src/config/agent-types";
import type { AssemblerIO } from "#src/session/session-config";
import type { AgentConfig } from "#src/types";
import { makeModel } from "#test/helpers/make-model";

const mockResolveAgentConfig = vi.fn((): AgentConfig => ({
  name: "Plan",
  description: "Software architect for implementation planning",
  builtinToolNames: ["read"],
  systemPrompt: "You are Plan.",
  promptMode: "replace",
}));
const mockGetToolNamesForType = vi.fn((): string[] => ["read"]);
const mockBuildAgentPrompt: Mock<AssemblerIO["buildAgentPrompt"]> = vi.fn(
  () => "assembled system prompt",
);

/** Mock registry injected into assembleSessionConfig instead of module-level free functions. */
const mockAgentLookup: AgentConfigLookup = {
  resolveAgentConfig: mockResolveAgentConfig,
  getToolNamesForType: mockGetToolNamesForType,
};

import { assembleSessionConfig } from "#src/session/session-config";

const mockEnv = { isGitRepo: false, branch: "", platform: "linux" };

const mockRegistry = {
  find: vi.fn((): Model<any> | undefined => undefined),
  getAll: vi.fn((): Model<any>[] => []),
  getAvailable: vi.fn((): Model<any>[] => []),
};

const ctx = {
  cwd: "/tmp",
  parentSystemPrompt: "parent prompt",
  modelRegistry: mockRegistry,
};

/** IO stubs injected into assembleSessionConfig in place of module-level imports. */
const mockIO = {
  buildAgentPrompt: mockBuildAgentPrompt,
};

/** The Plan agent config used across the model/thinking resolution tests. */
function planConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return { name: "Plan", description: "test", systemPrompt: "prompt", promptMode: "replace", ...overrides };
}

beforeEach(() => {
  mockResolveAgentConfig.mockClear();
  mockGetToolNamesForType.mockClear();
  mockBuildAgentPrompt.mockClear();
  mockRegistry.find.mockReset();
  mockRegistry.getAll.mockClear();
  mockRegistry.getAvailable.mockClear();
});

describe("assembleSessionConfig — default agent shape", () => {
  it("returns correct shape for Plan agent with defaults", () => {
    const result = assembleSessionConfig("Plan", ctx, {}, mockEnv, mockAgentLookup, mockIO);

    expect(result.effectiveCwd).toBe("/tmp");
    expect(result.systemPrompt).toBe("assembled system prompt");
    expect(result.toolNames).toEqual(["read"]);
    expect(result.model).toBeUndefined();
    expect(result.thinkingLevel).toBeUndefined();
  });

  it("uses options.cwd as effectiveCwd when provided", () => {
    const result = assembleSessionConfig("Plan", ctx, { cwd: "/tmp/worktree" }, mockEnv, mockAgentLookup, mockIO);

    expect(result.effectiveCwd).toBe("/tmp/worktree");
  });

  it("falls back to ctx.cwd when options.cwd is not set", () => {
    const result = assembleSessionConfig("Plan", ctx, {}, mockEnv, mockAgentLookup, mockIO);

    expect(result.effectiveCwd).toBe("/tmp");
  });

  it("systemPrompt reflects the parentSystemPrompt passed to buildAgentPrompt", () => {
    mockBuildAgentPrompt.mockImplementationOnce(
      (_config, _cwd, _env, inherited) => `assembled:${inherited?.systemPrompt}`,
    );

    const result = assembleSessionConfig("Plan", ctx, {}, mockEnv, mockAgentLookup, mockIO);

    expect(result.systemPrompt).toBe("assembled:parent prompt");
  });

  it("forwards the parent's cwd alongside its system prompt", () => {
    // The prompt builder needs the parent's cwd to redact the footer that text
    // claims — the child's own cwd is a separate argument.
    assembleSessionConfig(
      "Plan",
      ctx,
      { cwd: "/worktree" },
      mockEnv,
      mockAgentLookup,
      mockIO,
    );

    expect(mockBuildAgentPrompt).toHaveBeenCalledWith(
      mockResolveAgentConfig(),
      "/worktree",
      mockEnv,
      { systemPrompt: "parent prompt", cwd: "/tmp" },
    );
  });
});

describe("assembleSessionConfig — model resolution", () => {
  it("returns undefined model when no option, no config model, no parent", () => {
    const result = assembleSessionConfig("Plan", ctx, {}, mockEnv, mockAgentLookup, mockIO);

    expect(result.model).toBeUndefined();
  });

  it("options.model wins over config model and parent model", () => {
    const explicitModel = makeModel({ provider: "anthropic", id: "claude-opus-4" });
    mockResolveAgentConfig.mockReturnValueOnce(planConfig({ model: "anthropic/claude-haiku-4" }));

    const result = assembleSessionConfig(
      "Plan",
      { ...ctx, parentModel: makeModel({ provider: "anthropic", id: "claude-haiku-4" }) },
      { model: explicitModel },
      mockEnv,
      mockAgentLookup,
      mockIO,
    );

    expect(result.model).toBe(explicitModel);
  });

  it("config model string resolves via registry when available", () => {
    const resolvedModel = makeModel({ provider: "anthropic", id: "claude-opus-4" });
    mockResolveAgentConfig.mockReturnValueOnce(planConfig({ model: "anthropic/claude-opus-4" }));
    mockRegistry.find.mockReturnValueOnce(resolvedModel);
    mockRegistry.getAvailable.mockReturnValueOnce([
      makeModel({ provider: "anthropic", id: "claude-opus-4" }),
    ]);

    const result = assembleSessionConfig("Plan", ctx, {}, mockEnv, mockAgentLookup, mockIO);

    expect(mockRegistry.find).toHaveBeenCalledWith("anthropic", "claude-opus-4");
    expect(result.model).toBe(resolvedModel);
  });

  it("falls back to parentModel when config model string is not in registry", () => {
    const parentModel = makeModel({ provider: "anthropic", id: "claude-haiku-4" });
    mockResolveAgentConfig.mockReturnValueOnce(planConfig({ model: "anthropic/unknown-model" }));
    mockRegistry.find.mockReturnValueOnce(undefined);
    mockRegistry.getAvailable.mockReturnValueOnce([]);

    const result = assembleSessionConfig(
      "Plan",
      { ...ctx, parentModel },
      {},
      mockEnv,
      mockAgentLookup,
      mockIO,
    );

    expect(result.model).toBe(parentModel);
  });

  it("falls back to parentModel when config model is not available (not in getAvailable)", () => {
    const parentModel = makeModel({ provider: "anthropic", id: "claude-haiku-4" });
    const foundModel = makeModel({ provider: "anthropic", id: "claude-opus-4" });
    mockResolveAgentConfig.mockReturnValueOnce(planConfig({ model: "anthropic/claude-opus-4" }));
    // Model exists in registry but NOT in available set
    mockRegistry.find.mockReturnValueOnce(foundModel);
    mockRegistry.getAvailable.mockReturnValueOnce([]);

    const result = assembleSessionConfig(
      "Plan",
      { ...ctx, parentModel },
      {},
      mockEnv,
      mockAgentLookup,
      mockIO,
    );

    expect(result.model).toBe(parentModel);
  });

  it("falls back to parentModel when config model has no slash", () => {
    const parentModel = makeModel({ provider: "anthropic", id: "claude-haiku-4" });
    mockResolveAgentConfig.mockReturnValueOnce(planConfig({ model: "claude-opus-4" })); // no provider/ prefix

    const result = assembleSessionConfig(
      "Plan",
      { ...ctx, parentModel },
      {},
      mockEnv,
      mockAgentLookup,
      mockIO,
    );

    expect(result.model).toBe(parentModel);
  });

  it("returns parentModel when no config model and no option model", () => {
    const parentModel = makeModel({ provider: "anthropic", id: "claude-haiku-4" });

    const result = assembleSessionConfig(
      "Plan",
      { ...ctx, parentModel },
      {},
      mockEnv,
      mockAgentLookup,
      mockIO,
    );

    expect(result.model).toBe(parentModel);
  });
});

describe("assembleSessionConfig — unknown type fallback", () => {
  it("passes resolved config directly to buildAgentPrompt", () => {
    // resolveAgentConfig handles the fallback internally —
    // session-config just forwards whatever it returns
    mockResolveAgentConfig.mockReturnValueOnce({
      name: "general-purpose",
      description: "General-purpose",
      systemPrompt: "",
      promptMode: "append" as const,
    });

    mockBuildAgentPrompt.mockImplementationOnce(
      (config: { name: string }) => `resolved:${config.name}`,
    );

    const result = assembleSessionConfig("unknown-custom-agent", ctx, {}, mockEnv, mockAgentLookup, mockIO);

    expect(result.systemPrompt).toBe("resolved:general-purpose");
  });
});

describe("assembleSessionConfig — thinking level", () => {
  it("returns undefined thinkingLevel when neither option nor config sets it", () => {
    const result = assembleSessionConfig("Plan", ctx, {}, mockEnv, mockAgentLookup, mockIO);

    expect(result.thinkingLevel).toBeUndefined();
  });

  it("options.thinkingLevel wins over agentConfig.thinking", () => {
    mockResolveAgentConfig.mockReturnValueOnce(planConfig({ thinking: "low" }));

    const result = assembleSessionConfig(
      "Plan",
      ctx,
      { thinkingLevel: "high" },
      mockEnv,
      mockAgentLookup,
      mockIO,
    );

    expect(result.thinkingLevel).toBe("high");
  });

  it("agentConfig.thinking is used when no option is provided", () => {
    mockResolveAgentConfig.mockReturnValueOnce(planConfig({ thinking: "medium" }));

    const result = assembleSessionConfig("Plan", ctx, {}, mockEnv, mockAgentLookup, mockIO);

    expect(result.thinkingLevel).toBe("medium");
  });
});
