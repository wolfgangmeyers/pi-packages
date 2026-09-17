import { chmodSync, mkdirSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const OWNER_EXECUTABLE_DIRECTORY_MODE = 0o700;

/**
 * Create the persisted manager used for a subagent and repair its directory chain.
 *
 * Pi's SessionManager creates missing directories with the process umask applied
 * to an implicit mode. A restrictive umask can leave the session and tasks
 * directories without owner traversal, so prepare those directories explicitly.
 */
export function createSubagentSessionManager(cwd: string, sessionDir: string): SessionManager {
  ensureSubagentSessionDirectories(sessionDir);
  return SessionManager.create(cwd, sessionDir);
}

function ensureSubagentSessionDirectories(sessionDir: string): void {
  for (const directory of ownedDirectories(sessionDir)) {
    mkdirSync(directory, { recursive: true, mode: OWNER_EXECUTABLE_DIRECTORY_MODE });
    const currentMode = statSync(directory).mode & 0o7777;
    const accessibleMode = currentMode | OWNER_EXECUTABLE_DIRECTORY_MODE;
    if (currentMode !== accessibleMode) {
      chmodSync(directory, accessibleMode);
    }
  }
}

/**
 * Return the generated session/task directories from the outermost inward.
 *
 * A child can itself have a task directory, so the chain alternates between a
 * `tasks` directory and the session directory that contains it. Stop before
 * the shared sessions root, which belongs to the host rather than this manager.
 */
function ownedDirectories(sessionDir: string): string[] {
  const directories: string[] = [];
  let taskDirectory = resolve(sessionDir);

  if (basename(taskDirectory) !== "tasks") {
    return [taskDirectory];
  }

  while (basename(taskDirectory) === "tasks") {
    const sessionDirectory = dirname(taskDirectory);
    directories.push(taskDirectory, sessionDirectory);
    taskDirectory = dirname(sessionDirectory);
  }

  return directories.reverse();
}
