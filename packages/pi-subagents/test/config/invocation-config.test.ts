import { describe, expect, it } from "vitest";
import { resolveAgentInvocationConfig } from "#src/config/invocation-config";
import type { AgentConfig } from "#src/types";

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "Explore",
    description: "Explore",
    builtinToolNames: ["read"],
    systemPrompt: "Test agent",
    promptMode: "replace",
    inheritContext: false,
    ...overrides,
  };
}

describe("resolveAgentInvocationConfig", () => {
  it("prefers agent config over tool-call params for locked fields", () => {
    const resolved = resolveAgentInvocationConfig(
      makeConfig({
        model: "provider/config-model",
        thinking: "high",
        maxTurns: 42,
        inheritContext: false,
      }),
      {
        model: "provider/param-model",
        thinking: "minimal",
        max_turns: 1,
        inherit_context: true,
      },
    );

    expect(resolved).toEqual({
      modelInput: "provider/config-model",
      modelFromParams: false,
      thinking: "high",
      maxTurns: 42,
      inheritContext: false,
    });
    expect(resolved).not.toHaveProperty("runInBackground");
  });

  it("uses tool-call params when no agent config is available", () => {
    const resolved = resolveAgentInvocationConfig(undefined, {
      model: "provider/param-model",
      thinking: "minimal",
      max_turns: 3,
      inherit_context: true,
    });

    expect(resolved).toEqual({
      modelInput: "provider/param-model",
      modelFromParams: true,
      thinking: "minimal",
      maxTurns: 3,
      inheritContext: true,
    });
  });

  it("lets the caller fill inheritContext when config leaves it undefined", () => {
    const resolved = resolveAgentInvocationConfig(
      makeConfig({ inheritContext: undefined }),
      { inherit_context: true },
    );

    expect(resolved.inheritContext).toBe(true);
  });

  it("defaults inheritContext to false", () => {
    const resolved = resolveAgentInvocationConfig(
      makeConfig({ inheritContext: undefined }),
      {},
    );

    expect(resolved.inheritContext).toBe(false);
  });
});
