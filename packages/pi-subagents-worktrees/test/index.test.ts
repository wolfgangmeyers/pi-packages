import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getAgentDir,
  subscribeSubagentsService,
  loadWorktreesConfig,
  pruneWorktrees,
  findPreservedWorktrees,
} = vi.hoisted(() => ({
  getAgentDir: vi.fn((): string => "/fake/agent-dir"),
  subscribeSubagentsService: vi.fn(),
  loadWorktreesConfig: vi.fn(() => ({ worktreeAgents: ["Explore"] })),
  pruneWorktrees: vi.fn(),
  findPreservedWorktrees: vi.fn((): string[] => []),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({ getAgentDir }));
vi.mock("@gotgenes/pi-subagents", () => ({ subscribeSubagentsService }));
vi.mock("#src/config", () => ({ loadWorktreesConfig }));
vi.mock("#src/worktree", () => ({ pruneWorktrees }));
vi.mock("#src/preserved", () => ({
  findPreservedWorktrees,
  formatPreservedNotice: (paths: readonly string[]) =>
    `notice for ${paths.join(", ")}`,
}));

import { ActiveWorktrees } from "#src/active-worktrees";
import piSubagentsWorktrees from "#src/index";
import { WorktreeWorkspaceProvider } from "#src/workspace-provider";

type SessionHandler = (
  event: unknown,
  ctx: ReturnType<typeof fakeCtx>["ctx"],
) => void;
type ServiceListener = (
  service:
    | { registerWorkspaceProvider: (provider: unknown) => () => void }
    | undefined,
) => void;

/** Build a fake ExtensionAPI capturing event handlers. */
function fakePi() {
  const handlers = new Map<string, SessionHandler>();
  return {
    pi: {
      on: vi.fn((event: string, cb: SessionHandler) => handlers.set(event, cb)),
      registerCommand: vi.fn(),
    },
    handlers,
  };
}

/** Build an ExtensionContext double exposing only what the handlers read. */
function fakeCtx(hasUI = true, sessionId = "owner-session") {
  const notify = vi.fn();
  return {
    ctx: {
      hasUI,
      ui: { notify },
      sessionManager: { getSessionId: () => sessionId },
    },
    notify,
  };
}

describe("piSubagentsWorktrees extension entry", () => {
  let serviceListener: ServiceListener | undefined;
  let unsubscribeService: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    serviceListener = undefined;
    unsubscribeService = vi.fn();
    subscribeSubagentsService.mockReset();
    subscribeSubagentsService.mockImplementation(
      (_ownerSessionId: string, listener: ServiceListener) => {
        serviceListener = listener;
        listener(undefined);
        return unsubscribeService;
      },
    );
    pruneWorktrees.mockClear();
    getAgentDir.mockClear();
    loadWorktreesConfig.mockClear();
    findPreservedWorktrees.mockClear();
    findPreservedWorktrees.mockReturnValue([]);
  });

  it("waits for session_start before subscribing with the owning session ID", () => {
    const { pi, handlers } = fakePi();
    piSubagentsWorktrees(pi as never);

    expect(subscribeSubagentsService).not.toHaveBeenCalled();
    handlers.get("session_start")?.({}, fakeCtx(true, "parent-session").ctx);

    expect(subscribeSubagentsService).toHaveBeenCalledWith(
      "parent-session",
      expect.any(Function),
    );
    expect(loadWorktreesConfig).toHaveBeenCalledWith(
      "/fake/agent-dir",
      process.cwd(),
    );
    expect(pruneWorktrees).toHaveBeenCalledWith(process.cwd());
  });

  it("binds and rebinds the real provider as the owner service changes", () => {
    const firstUnregister = vi.fn();
    const secondUnregister = vi.fn();
    const firstRegister = vi.fn((_provider: unknown) => firstUnregister);
    const secondRegister = vi.fn((_provider: unknown) => secondUnregister);
    const { pi, handlers } = fakePi();
    piSubagentsWorktrees(pi as never);
    handlers.get("session_start")?.({}, fakeCtx().ctx);

    serviceListener?.({ registerWorkspaceProvider: firstRegister });
    const provider = firstRegister.mock.calls[0]?.[0];
    serviceListener?.({ registerWorkspaceProvider: secondRegister });

    expect(provider).toBeInstanceOf(WorktreeWorkspaceProvider);
    expect(firstUnregister).toHaveBeenCalledTimes(1);
    expect(secondRegister).toHaveBeenCalledWith(provider);
    expect(secondUnregister).not.toHaveBeenCalled();

    serviceListener?.(undefined);
    expect(secondUnregister).toHaveBeenCalledTimes(1);
    expect(unsubscribeService).toHaveBeenCalledTimes(1);
  });

  it("cleans up when publication is removed before subscription setup returns", () => {
    const unregisterProvider = vi.fn();
    subscribeSubagentsService.mockImplementation(
      (_ownerSessionId: string, listener: ServiceListener) => {
        listener({
          registerWorkspaceProvider: vi.fn(() => unregisterProvider),
        });
        listener(undefined);
        return unsubscribeService;
      },
    );
    const { pi, handlers } = fakePi();
    piSubagentsWorktrees(pi as never);

    handlers.get("session_start")?.({}, fakeCtx().ctx);

    expect(unregisterProvider).toHaveBeenCalledTimes(1);
    expect(unsubscribeService).toHaveBeenCalledTimes(1);
  });

  it("keeps the command available while the owner service is unpublished", () => {
    const { pi, handlers } = fakePi();
    piSubagentsWorktrees(pi as never);
    handlers.get("session_start")?.({}, fakeCtx().ctx);

    expect(pi.registerCommand).toHaveBeenCalledWith(
      "subagents-worktrees",
      expect.any(Object),
    );
  });

  it("cleans up the subscription and provider on shutdown", () => {
    const unregisterProvider = vi.fn();
    const registerWorkspaceProvider = vi.fn(() => unregisterProvider);
    const { pi, handlers } = fakePi();
    piSubagentsWorktrees(pi as never);
    handlers.get("session_start")?.({}, fakeCtx().ctx);
    serviceListener?.({ registerWorkspaceProvider });

    handlers.get("session_shutdown")?.({}, fakeCtx().ctx);

    expect(unsubscribeService).toHaveBeenCalledTimes(1);
    expect(unregisterProvider).toHaveBeenCalledTimes(1);
  });

  it("cleans up the previous binding when session_start runs again", () => {
    const unregisterProvider = vi.fn();
    const { pi, handlers } = fakePi();
    piSubagentsWorktrees(pi as never);
    handlers.get("session_start")?.({}, fakeCtx(true, "first-session").ctx);
    serviceListener?.({
      registerWorkspaceProvider: vi.fn(() => unregisterProvider),
    });

    handlers.get("session_start")?.({}, fakeCtx(true, "second-session").ctx);

    expect(unsubscribeService).toHaveBeenCalledTimes(1);
    expect(unregisterProvider).toHaveBeenCalledTimes(1);
    expect(subscribeSubagentsService).toHaveBeenLastCalledWith(
      "second-session",
      expect.any(Function),
    );
  });

  describe("preserved-worktree notice", () => {
    it("warns at session start about rescue worktrees left on disk", () => {
      findPreservedWorktrees.mockReturnValue([
        "/private/tmp/pi-agent-abc123-1f2e9c04",
      ]);
      const { pi, handlers } = fakePi();
      piSubagentsWorktrees(pi as never);
      const { ctx, notify } = fakeCtx();

      handlers.get("session_start")?.({ type: "session_start" }, ctx);

      expect(findPreservedWorktrees).toHaveBeenCalledWith(
        process.cwd(),
        expect.any(ActiveWorktrees),
      );
      expect(notify).toHaveBeenCalledWith(
        "notice for /private/tmp/pi-agent-abc123-1f2e9c04",
        "warning",
      );
    });

    it("stays silent when nothing was preserved", () => {
      const { pi, handlers } = fakePi();
      piSubagentsWorktrees(pi as never);
      const { ctx, notify } = fakeCtx();

      handlers.get("session_start")?.({ type: "session_start" }, ctx);

      expect(notify).not.toHaveBeenCalled();
    });

    it("does not scan in a session with no UI to notify", () => {
      findPreservedWorktrees.mockReturnValue([
        "/private/tmp/pi-agent-abc123-1f2e9c04",
      ]);
      const { pi, handlers } = fakePi();
      piSubagentsWorktrees(pi as never);
      const { ctx, notify } = fakeCtx(false);

      handlers.get("session_start")?.({ type: "session_start" }, ctx);

      expect(findPreservedWorktrees).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
    });
  });
});
