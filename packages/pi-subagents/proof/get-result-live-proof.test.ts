import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import subagentsExtension from "#src/index";
import { getSubagentsService } from "#src/service/service";

// Run explicitly: cd packages/pi-subagents && cfg=$(mktemp --suffix=.ts --tmpdir=.) && trap 'rm -f "$cfg"' EXIT && printf '%s\n' 'import config from "./vitest.config.ts"; export default { ...config, test: { ...config.test, include: ["proof/get-result-live-proof.test.ts"] } };' > "$cfg" && pnpm vitest run --config "$cfg"

const LIMIT_ERROR =
  "Polling burns extra tokens and is unacceptable. Wait for completion; do not poll again.";

const textOf = (result: { content: Array<{ type: string; text?: string }> }) => {
  const text = result.content.find((item) => item.type === "text")?.text;
  if (!text) throw new Error("tool returned no text content");
  return text;
};

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

describe("registered get_subagent_result live proof", () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it(
    "limits one real SDK child and resets after the real rolling window",
    async () => {
      tempDir = join(tmpdir(), `pi-subagents-live-proof-${Date.now()}`);
      const agentDir = join(tempDir, "agent");
      await mkdir(agentDir, { recursive: true });
      const settingsManager = SettingsManager.create(tempDir, agentDir);
      const sessionManager = SessionManager.inMemory();
      const resourceLoader = new DefaultResourceLoader({
        cwd: tempDir,
        agentDir,
        settingsManager,
        extensionFactories: [subagentsExtension],
      });
      await resourceLoader.reload();

      // eslint-disable-next-line @typescript-eslint/no-deprecated -- SDK proof uses the stable test model lookup.
      const model = getModel("anthropic", "claude-sonnet-4-5");
      const { session } = await createAgentSession({
        cwd: tempDir,
        agentDir,
        model,
        settingsManager,
        sessionManager,
        resourceLoader,
      });

      let parentSessionId = "";
      let childId: string | undefined;
      try {
        await session.bindExtensions({});
        parentSessionId = session.sessionManager.getSessionId();
        const subagent = session.getToolDefinition("subagent");
        const getResult = session.getToolDefinition("get_subagent_result");
        if (!subagent || !getResult) throw new Error("registered subagent tools are unavailable");

        const spawnResult = await subagent.execute(
          "live-proof-spawn",
          {
            prompt: "Run `sleep 120` with bash before completing. Do not return a final response until the command exits; the parent must inspect your running status.",
            description: "live proof child",
            subagent_type: "general-purpose",
            max_turns: 100,
          },
          new AbortController().signal,
          () => undefined,
          { sessionManager } as never,
        );
        const spawnText = textOf(spawnResult);
        childId = /^Agent ID: ([^\s]+)$/m.exec(spawnText)?.[1];
        if (!childId) throw new Error(`could not identify spawned child: ${spawnText}`);

        const read = () =>
          getResult.execute(
            "live-proof-read",
            { agent_id: childId },
            new AbortController().signal,
            () => undefined,
            { sessionManager } as never,
          );

        const firstThree = await Promise.all([read(), read(), read()]);
        expect(firstThree.map(textOf).every((text) => text.includes(`Agent: ${childId}`))).toBe(true);
        expect(session.sessionManager.getSessionId()).toBe(parentSessionId);

        expect(textOf(await read())).toBe(LIMIT_ERROR);
        expect(session.sessionManager.getSessionId()).toBe(parentSessionId);

        await wait(60_100);
        const afterReset = textOf(await read());
        expect(afterReset).toContain(`Agent: ${childId}`);
        expect(afterReset).not.toBe(LIMIT_ERROR);
        expect(session.sessionManager.getSessionId()).toBe(parentSessionId);
      } finally {
        if (childId) getSubagentsService(parentSessionId)?.abort(childId);
        session.dispose();
      }
    },
    90_000,
  );
});
