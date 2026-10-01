import { describe, expect, it, vi } from "vitest";

const { buildParentContextMock } = vi.hoisted(() => ({
  buildParentContextMock: vi.fn((): string => ""),
}));

vi.mock("#src/session/context", () => ({
  buildParentContext: buildParentContextMock,
}));

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildParentSnapshot } from "#src/lifecycle/parent-snapshot";

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    cwd: "/test/project",
    getSystemPrompt: () => "parent system prompt",
    model: { id: "claude-sonnet" },
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getBranch: vi.fn(() => []) },
    ...overrides,
  } as unknown as ExtensionContext;
}

describe("buildParentSnapshot", () => {
  it("captures cwd from ctx", () => {
    const snapshot = buildParentSnapshot(makeCtx({ cwd: "/custom/path" }));
    expect(snapshot.cwd).toBe("/custom/path");
  });

  it("captures systemPrompt from ctx.getSystemPrompt()", () => {
    const snapshot = buildParentSnapshot(makeCtx({ getSystemPrompt: () => "my prompt" }));
    expect(snapshot.systemPrompt).toBe("my prompt");
  });

  it("captures model from ctx", () => {
    const model = { id: "claude-haiku", provider: "anthropic" };
    const snapshot = buildParentSnapshot(makeCtx({ model }));
    expect(snapshot.model).toBe(model);
  });

  it("captures modelRegistry from ctx", () => {
    const registry = { find: vi.fn(), getAvailable: vi.fn(() => []) };
    const snapshot = buildParentSnapshot(makeCtx({ modelRegistry: registry }));
    expect(snapshot.modelRegistry).toBe(registry);
  });

  it("sets parentContext to undefined when inheritContext is false", () => {
    const snapshot = buildParentSnapshot(makeCtx(), false);
    expect(snapshot.parentContext).toBeUndefined();
    expect(buildParentContextMock).not.toHaveBeenCalled();
  });

  it("sets parentContext to undefined when inheritContext is undefined", () => {
    const snapshot = buildParentSnapshot(makeCtx());
    expect(snapshot.parentContext).toBeUndefined();
    expect(buildParentContextMock).not.toHaveBeenCalled();
  });

  it("populates parentContext when inheritContext is true and conversation exists", () => {
    buildParentContextMock.mockReturnValueOnce("# Parent Conversation\n...");
    const snapshot = buildParentSnapshot(makeCtx(), true);
    expect(snapshot.parentContext).toBe("# Parent Conversation\n...");
    expect(buildParentContextMock).toHaveBeenCalledTimes(1);
  });

  it("sets parentContext to undefined when inheritContext is true but conversation is empty", () => {
    buildParentContextMock.mockReturnValueOnce("");
    const snapshot = buildParentSnapshot(makeCtx(), true);
    expect(snapshot.parentContext).toBeUndefined();
  });

  it("captures authStorage and modelRuntime from ctx.modelRegistry", () => {
    const mockAuthStorage = { get: vi.fn() };
    const mockRuntime = { getModels: vi.fn() };
    const registry = {
      find: vi.fn(),
      getAll: vi.fn(() => []),
      authStorage: mockAuthStorage,
      runtime: mockRuntime,
    };
    const snapshot = buildParentSnapshot(makeCtx({ modelRegistry: registry }));
    expect(snapshot.authStorage).toBe(mockAuthStorage);
    expect(snapshot.modelRuntime).toBe(mockRuntime);
  });

  it("derives authStorage from modelRuntime.credentials when authStorage is absent", () => {
    const mockCredentials = { read: vi.fn() };
    const mockRuntime = { credentials: mockCredentials };
    const registry = {
      find: vi.fn(),
      getAll: vi.fn(() => []),
      runtime: mockRuntime,
    };
    const snapshot = buildParentSnapshot(makeCtx({ modelRegistry: registry }));
    expect(snapshot.authStorage).toBe(mockCredentials);
    expect(snapshot.modelRuntime).toBe(mockRuntime);
  });

  it("captures authStorage and modelRuntime from ctx directly when present", () => {
    const mockAuthStorage = { get: vi.fn() };
    const mockModelRuntime = { getAuth: vi.fn() };
    const snapshot = buildParentSnapshot(
      makeCtx({
        authStorage: mockAuthStorage,
        modelRuntime: mockModelRuntime,
      }),
    );
    expect(snapshot.authStorage).toBe(mockAuthStorage);
    expect(snapshot.modelRuntime).toBe(mockModelRuntime);
  });
});
