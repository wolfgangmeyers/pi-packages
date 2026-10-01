import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { type CreateSessionOptions, createSubagentSession } from "#src/lifecycle/create-subagent-session";
import { buildParentSnapshot, type ParentSnapshot } from "#src/lifecycle/parent-snapshot";
import { createSubagentSessionManager } from "#src/session/session-manager";
import type { SessionContext } from "#src/types";
import { makeModel } from "#test/helpers/make-model";
import {
  createAgentLookup,
  createFactorySession,
  createSubagentSessionDeps,
  createSubagentSessionIO,
} from "#test/helpers/subagent-session-io";

describe("antigravity and OAuth provider propagation", () => {
  it("captures modelRuntime and authStorage from parent context and passes them to child session", async () => {
    const mockRuntime = {
      hasConfiguredAuth: vi.fn(() => true),
      getAuth: vi.fn(),
    };
    const mockAuthStorage = {
      getApiKey: vi.fn(),
    };
    const antigravityModel = makeModel({
      id: "gemini-3.8-flash",
      provider: "antigravity",
      name: "Gemini 3.8 Flash",
    });
    const mockModelRegistry = {
      find: vi.fn(() => antigravityModel),
      getAll: vi.fn(() => []),
      getAvailable: vi.fn(() => [antigravityModel]),
      runtime: mockRuntime,
      authStorage: mockAuthStorage,
    };

    const ctx: SessionContext = {
      cwd: "/test/project",
      getSystemPrompt: () => "parent prompt",
      model: antigravityModel,
      modelRegistry: mockModelRegistry,
      sessionManager: {
        getSessionFile: () => "/test/parent.jsonl",
        getSessionId: () => "parent-session-123",
        getBranch: () => [],
      },
    };

    // 1. buildParentSnapshot captures authStorage and modelRuntime
    const snapshot = buildParentSnapshot(ctx);
    expect(snapshot.modelRuntime).toBe(mockRuntime);
    expect(snapshot.authStorage).toBe(mockAuthStorage);
    expect(snapshot.model).toBe(antigravityModel);

    // 2. createSubagentSession forwards them into deps.io.createSession
    const io = createSubagentSessionIO();
    const session = createFactorySession();
    io.createSession.mockResolvedValue({ session });

    const deps = createSubagentSessionDeps({
      io,
      exec: vi.fn(),
      registry: createAgentLookup(),
    });

    const sub = await createSubagentSession({ snapshot, type: "Plan" }, deps);

    expect(sub).toBeDefined();
    expect(io.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        modelRegistry: mockModelRegistry,
        modelRuntime: mockRuntime,
        authStorage: mockAuthStorage,
        model: expect.objectContaining({ provider: "antigravity", id: "gemini-3.8-flash" }),
      }),
    );
  });

  it("allows child session created via createAgentSession to authenticate OAuth provider", async () => {
    const authStorage = AuthStorage.inMemory({
      antigravity: {
        type: "oauth",
        access: "mock-access-token",
        refresh: "mock-refresh-token",
        expires: Date.now() + 3600_000,
      },
    });
    const modelRegistry = ModelRegistry.inMemory(authStorage);
    modelRegistry.registerProvider("antigravity", {
      baseUrl: "https://cloudcode-pa.googleapis.com",
      api: "anthropic-messages",
      models: [
        {
          id: "gemini-3.8-flash",
          name: "Gemini 3.8 Flash",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 16384,
        },
      ],
      oauth: {
        name: "Antigravity",
        login: async () => ({ access: "", refresh: "", expires: 0 }),
        refreshToken: async () => ({ access: "", refresh: "", expires: 0 }),
        getApiKey: () => "mock-key",
      },
      streamSimple: () => createAssistantMessageEventStream(),
    });

    const model = modelRegistry.find("antigravity", "gemini-3.8-flash");
    expect(model).toBeDefined();

    const snapshot: ParentSnapshot = {
      cwd: "/test",
      systemPrompt: "prompt",
      model,
      modelRegistry,
      authStorage,
      modelRuntime: (modelRegistry as any).runtime,
    };

    const loader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: "/tmp",
      noExtensions: true,
    });
    await loader.reload();

    const sessionManager = createSubagentSessionManager(process.cwd(), "/tmp/session-test/tasks");
    sessionManager.newSession({});

    const createSession = (opts: CreateSessionOptions) =>
      createAgentSession(opts as unknown as Parameters<typeof createAgentSession>[0]);

    const { session } = await createSession({
      cwd: process.cwd(),
      agentDir: "/tmp",
      sessionManager,
      settingsManager: SettingsManager.create(process.cwd(), "/tmp"),
      modelRegistry: snapshot.modelRegistry,
      authStorage: snapshot.authStorage,
      modelRuntime: snapshot.modelRuntime,
      model: snapshot.model,
      tools: ["read"],
      resourceLoader: loader,
    });

    expect(session.modelRegistry.hasConfiguredAuth(model!)).toBe(true);
  });
});
