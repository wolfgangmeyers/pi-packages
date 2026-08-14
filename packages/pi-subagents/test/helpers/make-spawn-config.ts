import type { ResolvedSpawnConfig } from "#src/tools/spawn-config";

/** Flat options for {@link createResolvedSpawnConfig}; only the scalars tests vary. */
export interface ResolvedSpawnConfigOptions {
  subagentType?: string;
  rawType?: string;
  fellBack?: boolean;
  displayName?: string;
  prompt?: string;
  description?: string;
  model?: string;
}

/**
 * Build a `ResolvedSpawnConfig` for tool tests from flat options.
 *
 * Derives the mirrored display regions the hand-built fixtures duplicate:
 * `displayName`/`description`/`subagentType`/`model` → `presentation.detailBase`.
 * Flat options sidestep the `Partial<ResolvedSpawnConfig>` deep-merge trap.
 */
export function createResolvedSpawnConfig(
  options: ResolvedSpawnConfigOptions = {},
): ResolvedSpawnConfig {
  const subagentType = options.subagentType ?? "general-purpose";
  const displayName = options.displayName ?? "Agent";
  const description = options.description ?? "task";
  const modelName = options.model;

  return {
    identity: {
      subagentType,
      rawType: options.rawType ?? subagentType,
      fellBack: options.fellBack ?? false,
      displayName,
    },
    execution: {
      prompt: options.prompt ?? "do the task",
      description,
      model: undefined,
      effectiveMaxTurns: undefined,
      thinking: undefined,
      inheritContext: false,
      agentInvocation: {
        modelName,
        thinking: undefined,
        maxTurns: undefined,
        inheritContext: false,
      },
    },
    presentation: {
      modelName,
      agentTags: [],
      detailBase: { displayName, description, subagentType, modelName, tags: undefined },
    },
  };
}
