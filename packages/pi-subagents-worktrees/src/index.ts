/**
 * pi-subagents-worktrees — git worktree isolation for @gotgenes/pi-subagents.
 *
 * Registers a WorkspaceProvider (ADR 0002, Phase 16 Step 3) that runs opted-in
 * subagents in a temporary git worktree. The core consults the provider for
 * every child run; this package decides which agents get a worktree (via the
 * worktreeAgents config) and brackets the run with git plumbing.
 *
 * The provider subscribes to the owner-scoped SubagentsService at session
 * start. This handles either package load order and rebinds when the owning
 * service is published or replaced.
 */

import {
  type ExtensionAPI,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { SubagentsService } from "@gotgenes/pi-subagents";
import * as subagentsPackage from "@gotgenes/pi-subagents";
import { ActiveWorktrees } from "#src/active-worktrees";
import { loadWorktreesConfig } from "#src/config";
import { findPreservedWorktrees, formatPreservedNotice } from "#src/preserved";
import { registerPreservedWorktreesCommand } from "#src/preserved-command";
import { WorktreeWorkspaceProvider } from "#src/workspace-provider";
import { discardWorktree, pruneWorktrees } from "#src/worktree";

type SubscribeSubagentsService = (
  ownerSessionId: string,
  listener: (service: SubagentsService | undefined) => void,
) => () => void;

const subscribeSubagentsService = (
  subagentsPackage as typeof subagentsPackage & {
    subscribeSubagentsService: SubscribeSubagentsService;
  }
).subscribeSubagentsService;

export default function piSubagentsWorktrees(pi: ExtensionAPI): void {
  const config = loadWorktreesConfig(getAgentDir(), process.cwd());

  // Best-effort crash recovery: clear worktrees orphaned by a prior crash.
  pruneWorktrees(process.cwd());

  const live = new ActiveWorktrees();
  const provider = new WorktreeWorkspaceProvider(config, live);
  let unsubscribeService: (() => void) | undefined;
  let unregisterProvider: (() => void) | undefined;
  let serviceWasPublished = false;

  const clearProvider = (): void => {
    unregisterProvider?.();
    unregisterProvider = undefined;
  };
  const clearSessionBinding = (): void => {
    unsubscribeService?.();
    unsubscribeService = undefined;
    serviceWasPublished = false;
    clearProvider();
  };

  const repoCwd = process.cwd();
  const findPreserved = () => findPreservedWorktrees(repoCwd, live);

  // The rescue worktrees a failed cleanup left behind are reported once per
  // session start. A session with no UI (every subagent child) has nowhere to
  // show them, so it does not even look.
  pi.on("session_start", (_event, ctx) => {
    clearSessionBinding();
    const subscriptionState = {
      ready: false,
      removeWhenReady: false,
    };
    const unsubscribe = subscribeSubagentsService(
      ctx.sessionManager.getSessionId(),
      (service) => {
        clearProvider();
        if (!service) {
          if (serviceWasPublished) {
            if (subscriptionState.ready) {
              unsubscribeService?.();
              unsubscribeService = undefined;
            } else {
              subscriptionState.removeWhenReady = true;
            }
          }
          return;
        }
        serviceWasPublished = true;
        unregisterProvider = service.registerWorkspaceProvider(provider);
      },
    );
    subscriptionState.ready = true;
    if (subscriptionState.removeWhenReady) unsubscribe();
    else unsubscribeService = unsubscribe;

    if (!ctx.hasUI) return;
    const preserved = findPreserved();
    if (preserved.length > 0) {
      ctx.ui.notify(formatPreservedNotice(preserved), "warning");
    }
  });

  registerPreservedWorktreesCommand(pi, {
    findPreserved,
    discard: (path) => discardWorktree(repoCwd, path),
  });

  pi.on("session_shutdown", clearSessionBinding);
}
