import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getModel, registerApiProvider, registerBuiltInApiProviders, unregisterApiProviders } from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import subagentsExtension from "#src/index";
import { getSubagentsService } from "#src/service/service";

const CANONICAL_MECHA_EXTENSION = "/home/ubuntu/.mecha-developer/extensions/mecha-messaging.js";
const MECHA_ROUTER_ENTRYPOINT = "/home/ubuntu/code/mecha-developer/tools/run_router.mjs";
const RESULT_LEDGER_AGENT = "live-proof-result-ledger";
const PARENT_AGENT_ID = "live-proof-parent";

type IsolatedRouter = {
	httpUrl: string;
	close(): Promise<void>;
};

// Run explicitly: cd packages/pi-subagents && cfg=$(mktemp --suffix=.ts --tmpdir=.) && trap 'rm -f "$cfg"' EXIT && printf '%s\n' 'import config from "./vitest.config.ts"; export default { ...config, test: { ...config.test, include: ["proof/get-result-live-proof.test.ts"] } };' > "$cfg" && pnpm vitest run --config "$cfg"

const LIMIT_ERROR =
  "Polling burns extra tokens and is unacceptable. Wait for completion; do not poll again.";

const textOf = (result: { content: Array<{ type: string; text?: string }> }) => {
  const text = result.content.find((item) => item.type === "text")?.text;
  if (!text) throw new Error("tool returned no text content");
  return text;
};

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForRouterAgent(routerUrl: string, agentId: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const response = await fetch(`${routerUrl}/v1/agents?models=omit`);
		const snapshot = (await response.json()) as { agents?: Array<{ agent_id?: string }> };
		if (snapshot.agents?.some((agent) => agent.agent_id === agentId)) return;
		await wait(25);
	}
	throw new Error(`router did not register ${agentId}`);
}

function restoreEnvironment(previous: Record<string, string | undefined>): void {
	for (const [name, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
}

describe("registered get_subagent_result live proof", () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it(
    "limits one real SDK child and resets after the real rolling window",
    async () => {
      tempDir = await mkdtemp(join(tmpdir(), "pi-subagents-live-proof-"));
      const agentDir = join(tempDir, "agent");
      const fakeBinDir = join(tempDir, "bin");
      const resultLedgerPath = join(tempDir, "result-attempts.jsonl");
      await mkdir(agentDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });
      // The canonical extension resolves its identity from tmux. Keep the proof independent of the
      // caller's tmux window while exercising that production identity path.
      await writeFile(
        join(fakeBinDir, "tmux"),
        `#!/bin/sh\nprintf '%s\\n' 'live-proof-parent'\n`,
        { mode: 0o755 },
      );

      const previousEnvironment = {
        PATH: process.env.PATH,
        TMUX: process.env.TMUX,
        TMUX_PANE: process.env.TMUX_PANE,
        MECHA_KB_ROOT: process.env.MECHA_KB_ROOT,
        MECHA_ROUTER_URL: process.env.MECHA_ROUTER_URL,
      };
      process.env.PATH = `${fakeBinDir}:${process.env.PATH ?? ""}`;
      process.env.TMUX = "live-proof";
      process.env.TMUX_PANE = "%1";
      process.env.MECHA_KB_ROOT = join(tempDir, "kb");

      let router: IsolatedRouter | undefined;
      let parentSessionId = "";
      let childId: string | undefined;
      let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
      try {
        const { startRouter } = (await import(pathToFileURL(MECHA_ROUTER_ENTRYPOINT).href)) as {
          startRouter(options: {
            database: string;
            log: string;
            host: string;
            port: number;
            output: () => undefined;
          }): Promise<IsolatedRouter>;
        };
        router = await startRouter({
          database: join(tempDir, "router.sqlite"),
          log: join(tempDir, "router.jsonl"),
          host: "127.0.0.1",
          port: 0,
          output: () => undefined,
        });
        if (router === undefined) throw new Error("isolated router did not start");
        const activeRouter = router;
        process.env.MECHA_ROUTER_URL = activeRouter.httpUrl;

        const mechaModule = (await import(pathToFileURL(CANONICAL_MECHA_EXTENSION).href)) as {
          default: typeof subagentsExtension;
        };
        const mechaExtension = mechaModule.default;
        const settingsManager = SettingsManager.create(tempDir, agentDir);
        const sessionManager = SessionManager.inMemory();
        const resourceLoader = new DefaultResourceLoader({
          cwd: tempDir,
          agentDir,
          settingsManager,
          extensionFactories: [subagentsExtension, mechaExtension],
        });
        await resourceLoader.reload();

        // Keep the real child session running without credentials or network traffic. The known
        // Anthropic model still exercises the SDK's normal model selection and tool loop.
        const faux = fauxProvider({
          api: "anthropic-messages",
          provider: "anthropic",
          models: [{ id: "claude-sonnet-4-5" }],
        });
        registerApiProvider(faux.provider, "live-proof");
        faux.setResponses([
          fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 120" }), { stopReason: "toolUse" }),
        ]);
        // eslint-disable-next-line @typescript-eslint/no-deprecated -- SDK proof uses the stable test model lookup.
        const model = getModel("anthropic", "claude-sonnet-4-5");
        const modelRegistry = {
          getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "test" }),
          hasConfiguredAuth: () => true,
        } as never;

        const created = await createAgentSession({
          cwd: tempDir,
          agentDir,
          model,
          modelRegistry,
          settingsManager,
          sessionManager,
          resourceLoader,
        });
        session = created.session;
        await session.bindExtensions({});
        parentSessionId = session.sessionManager.getSessionId();
        await waitForRouterAgent(activeRouter.httpUrl, PARENT_AGENT_ID);

        const subagent = session.getToolDefinition("subagent");
        const getResult = session.getToolDefinition("get_subagent_result");
        const mailboxSend = session.getToolDefinition("mecha_mailbox_send");
        if (!subagent || !getResult || !mailboxSend) {
          throw new Error("registered subagent and canonical Mecha tools are unavailable");
        }

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

        const persistAcceptedResult = async (attempt: number, resultText: string) => {
          // These are real canonical Mecha POSTs. The router conversation is the durable count;
          // the local JSONL ledger also preserves the denied fourth attempt for exact validation.
          const sent = await mailboxSend.execute(
            `live-proof-ledger-${attempt}`,
            {
              recipient: RESULT_LEDGER_AGENT,
              body: `subagent-result attempt ${attempt}: ${resultText.replace(/\s+/g, " ")}`,
              subject: `subagent-result-${attempt}`,
            },
            new AbortController().signal,
            () => undefined,
            { sessionManager } as never,
          );
          expect(sent.isError, sent.content[0]?.text).not.toBe(true);
          await appendFile(
            resultLedgerPath,
            `${JSON.stringify({ attempt, accepted: true, response: resultText, message: sent.details?.message_id })}\n`,
          );
        };

        const firstThree = await Promise.all([read(), read(), read()]);
        const firstThreeText = firstThree.map(textOf);
        expect(firstThreeText.every((text) => text.includes(`Agent: ${childId}`))).toBe(true);
        expect(session.sessionManager.getSessionId()).toBe(parentSessionId);
        for (const [index, resultText] of firstThreeText.entries()) {
          await persistAcceptedResult(index + 1, resultText);
        }

        const rejectedText = textOf(await read());
        expect(rejectedText).toBe(LIMIT_ERROR);
        await appendFile(
          resultLedgerPath,
          `${JSON.stringify({ attempt: 4, accepted: false, response: rejectedText })}\n`,
        );
        expect(session.sessionManager.getSessionId()).toBe(parentSessionId);

        const persistedAttempts = (await readFile(resultLedgerPath, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { attempt: number; accepted: boolean; response: string });
        expect(persistedAttempts.map(({ attempt, accepted }) => ({ attempt, accepted }))).toEqual([
          { attempt: 1, accepted: true },
          { attempt: 2, accepted: true },
          { attempt: 3, accepted: true },
          { attempt: 4, accepted: false },
        ]);
        expect(persistedAttempts[3]?.response).toBe(LIMIT_ERROR);

        const conversationResponse = await fetch(
          `${activeRouter.httpUrl}/v1/conversations?owner=${PARENT_AGENT_ID}&peer=${RESULT_LEDGER_AGENT}`,
        );
        expect(conversationResponse.ok).toBe(true);
        const conversation = (await conversationResponse.json()) as {
          messages?: Array<{ subject?: string; body?: string }>;
        };
        expect(conversation.messages?.map(({ subject }) => subject)).toEqual([
          "subagent-result-1",
          "subagent-result-2",
          "subagent-result-3",
        ]);
        expect(conversation.messages?.map(({ body }) => body?.startsWith("subagent-result attempt "))).toEqual([
          true,
          true,
          true,
        ]);
        expect(conversation.messages).toHaveLength(3);

        const resetWaitStarted = Date.now();
        await wait(60_100);
        const afterReset = textOf(await read());
        expect(Date.now() - resetWaitStarted).toBeGreaterThanOrEqual(60_000);
        expect(afterReset).toContain(`Agent: ${childId}`);
        expect(afterReset).not.toBe(LIMIT_ERROR);
        expect(session.sessionManager.getSessionId()).toBe(parentSessionId);
      } finally {
        try {
          if (childId) getSubagentsService(parentSessionId)?.abort(childId);
          session?.dispose();
          if (router !== undefined) await router.close();
        } finally {
          unregisterApiProviders("live-proof");
          registerBuiltInApiProviders();
          restoreEnvironment(previousEnvironment);
        }
      }
    },
    90_000,
  );
});
