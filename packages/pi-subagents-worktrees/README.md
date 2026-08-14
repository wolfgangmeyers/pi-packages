# @gotgenes/pi-subagents-worktrees

[![npm version](https://img.shields.io/npm/v/@gotgenes/pi-subagents-worktrees?style=flat&logo=npm&logoColor=white)](https://www.npmjs.com/package/@gotgenes/pi-subagents-worktrees) [![CI](https://img.shields.io/github/actions/workflow/status/gotgenes/pi-packages/ci.yml?style=flat&logo=github&label=CI)](https://github.com/gotgenes/pi-packages/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat)](https://opensource.org/licenses/MIT) [![TypeScript](https://img.shields.io/badge/TypeScript-6.x-3178C6?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/) [![pnpm](https://img.shields.io/badge/pnpm-%3E%3D11-F69220?style=flat&logo=pnpm&logoColor=white)](https://pnpm.io/) [![Pi Package](https://img.shields.io/badge/Pi-Package-6366F1?style=flat)](https://pi.mariozechner.at/)

Git worktree isolation for [`@gotgenes/pi-subagents`](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-subagents).

This extension registers a `WorkspaceProvider` with the subagents core: opted-in agents run in a temporary git worktree (an isolated copy of the repo), and any changes they make are saved to a branch when they finish.
Worktrees are one *workspace strategy*, not core behavior — so the git plumbing lives here, outside the minimal subagents core (see [ADR-0002] in the pi-subagents package).

## Install

Install this package with `@gotgenes/pi-subagents` 20 or newer.
The extension subscribes to the current Pi session's subagents service, so package load order does not affect provider registration.
It also rebinds the provider if the core service is published or replaced after session start.

```json
{
  "packages": [
    "npm:@gotgenes/pi-subagents",
    "npm:@gotgenes/pi-subagents-worktrees"
  ]
}
```

`@gotgenes/pi-subagents` is a required peer dependency.

## Configuration

Worktree isolation is **opt-in per agent type**.
List the agent types that should run in a worktree in a `subagents-worktrees.json` file:

- Global: `~/.pi/agent/subagents-worktrees.json`
- Project: `<cwd>/.pi/subagents-worktrees.json` (overrides global)

```json
{
  "worktreeAgents": ["general-purpose", "refactorer"]
}
```

An agent type not in `worktreeAgents` runs in the parent working directory, exactly as if this extension were not installed.

## Behavior

- A child whose agent type is listed gets a fresh detached worktree at `HEAD` before it runs.
- When the child finishes with no changes, the worktree is removed.
- When the child finishes with changes, they are committed to a branch (`pi-agent-<id>`), and the child's result gains a note: `Changes saved to branch \`<branch>\`. Merge with: \`git merge <branch>\``.
- If a commit hook rejects that commit, it is retried once with `--no-verify`, because the commit exists to rescue work the child already did and a rejecting hook would otherwise cost you that work.
  Files a hook rewrote before failing are re-staged, so a formatter's corrections are committed rather than discarded.
  The note then gains a second line reading `Commit hooks were bypassed to save this work — review the commit before merging.`
- If cleanup fails for any other reason, the worktree is **left in place** rather than removed, and the child's result gains a note: `Worktree cleanup failed; the worktree was left in place at \`<path>\` for manual recovery: <error>`.
  Nothing is deleted while its state is uncertain, so the work stays recoverable.
- If worktree creation fails for an opted-in agent (not a git repo, no commits yet, or `git worktree add` fails), the child run **fails** with an explanatory error rather than silently running unisolated.
- At the start of every session with a UI, any rescue worktrees still on disk are named in a warning, so a preserved worktree is not forgotten once the child's result scrolls out of view.

## Recovering preserved worktrees

A preserved worktree is a plain git worktree with the agent's work still in it.
Inspect it with `git -C <path> status`, and recover the work however you normally would — commit it on a branch, or copy the files out.

Run `/subagents-worktrees` at any time to list the preserved worktrees for the current repository.
Selecting one offers to remove it, and removal happens only after you confirm — nothing here is ever deleted automatically, because a failed cleanup is exactly the case where the content is not safe to discard on the extension's judgment.

A worktree is listed when it is registered with the repository, named with this package's `pi-agent-` prefix, still on disk, and not currently in use by a child of this session.
A worktree belonging to a **different** Pi process running against the same repository cannot be told apart from an abandoned one, so it is listed too — check the path before removing anything.

## Migrating from `isolation: "worktree"`

Earlier versions of `@gotgenes/pi-subagents` accepted an `isolation: "worktree"` spawn flag.
That flag was removed from the core; install this package and list the agent types you want isolated in `worktreeAgents` instead.

## License

MIT

[ADR-0002]: https://github.com/gotgenes/pi-packages/blob/main/packages/pi-subagents/docs/decisions/0002-extensions-on-a-minimal-core.md
