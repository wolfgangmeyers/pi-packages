import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("#src/lifecycle/create-subagent-session", async () => {
  const actual = await vi.importActual<typeof import("#src/lifecycle/create-subagent-session")>(
    "#src/lifecycle/create-subagent-session",
  );
  return {
    ...actual,
    createSubagentSession: vi.fn(),
  };
});

import subagentsExtension from "#src/index";
import { createSubagentSession } from "#src/lifecycle/create-subagent-session";
import { getSubagentsService } from "#src/service/service";
import { createMockSession, createSubagentSessionStub, toSubagentSession } from "./helpers/mock-session";

function makePi() {
  const tools = new Map<string, any>();
  const handlers = new Map<string, any>();
  const eventHandlers = new Map<string, any>();

  return {
    pi: {
      registerMessageRenderer: vi.fn(),
      registerTool: vi.fn((tool: any) => {
        tools.set(tool.name, tool);
      }),
      registerCommand: vi.fn(),
      on: vi.fn((event: string, handler: any) => {
        handlers.set(event, handler);
      }),
      events: {
        emit: vi.fn(),
        on: vi.fn((event: string, handler: any) => {
          eventHandlers.set(event, handler);
          return vi.fn();
        }),
      },
      appendEntry: vi.fn(),
      sendMessage: vi.fn(() => {
        throw new Error("stale extension context");
      }),
    } as any,
    tools,
    handlers,
  };
}

function makeHeadlessCtx() {
  return {
    hasUI: false,
    ui: {
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    },
    cwd: "/tmp",
    model: undefined,
    modelRegistry: {
      find: vi.fn(),
      getAvailable: vi.fn(() => []),
    },
    sessionManager: {
      getSessionId: vi.fn(() => "session-1"),
      getSessionFile: vi.fn(() => "/sessions/parent.jsonl"),
      getLeafId: vi.fn(() => "entry-1"),
      getLeafEntry: vi.fn(() => ({
        id: "entry-1",
        parentId: null,
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "tool-call-1" }],
        },
      })),
      getEntry: vi.fn(() => undefined),
      getBranch: vi.fn(() => []),
    },
    getSystemPrompt: vi.fn(() => "parent prompt"),
  } as any;
}

describe("print mode background notifications", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("ignores stale-context errors from delayed completion nudges", async () => {
    vi.mocked(createSubagentSession).mockResolvedValue(
      toSubagentSession(createSubagentSessionStub(createMockSession(), "/sessions/child.jsonl")),
    );

    const { pi, tools, handlers } = makePi();
    subagentsExtension(pi);
    vi.useFakeTimers();

    // Fire session_start so runtime.currentCtx is populated for buildSnapshot
    const ctx = makeHeadlessCtx();
    await handlers.get("session_start")?.({}, ctx);

    const agentTool = tools.get("subagent");
    await agentTool.execute(
      "tool-call-1",
      {
        prompt: "reply done",
        description: "tiny child",
        subagent_type: "general-purpose",
      },
      undefined,
      undefined,
      makeHeadlessCtx(),
    );

    await vi.advanceTimersByTimeAsync(100); // smart-join batch debounce
    await vi.advanceTimersByTimeAsync(200); // notification hold window

    expect(pi.sendMessage).toHaveBeenCalled();

    await handlers.get("session_shutdown")?.({}, makeHeadlessCtx());
  });

  it("bridges manager V2 deltas through the published service and index event observer", async () => {
    vi.mocked(createSubagentSession).mockResolvedValue(
      toSubagentSession(createSubagentSessionStub(createMockSession(), "/sessions/child.jsonl")),
    );
    const { pi, handlers } = makePi();
    subagentsExtension(pi);
    const ctx = makeHeadlessCtx();

    await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
    const service = getSubagentsService("session-1");
    expect(service).toBeDefined();

    service!.spawn("general-purpose", "track this lifecycle", { description: "lifecycle bridge" });

    await vi.waitFor(() => {
      expect(pi.events.emit).toHaveBeenCalledWith(
        "subagents:lifecycle-v2",
        expect.objectContaining({
          protocol: "mecha.children/v1",
          owner_session_id: "session-1",
        }),
      );
    });

    const lifecycleDelta = pi.events.emit.mock.calls.find(
      (call: readonly unknown[]) => call[0] === "subagents:lifecycle-v2",
    )?.[1];
    expect(lifecycleDelta).toEqual(expect.objectContaining({
      protocol: "mecha.children/v1",
      owner_session_id: "session-1",
    }));

    await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, ctx);
  });
});
