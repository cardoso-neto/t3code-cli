import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { OrchestrationProjectShell, OrchestrationShellSnapshot, OrchestrationThreadShell } from "@t3tools/contracts";
import type { T3Client } from "./client.ts";
import { T3Error } from "./errors.ts";

type Match<T> = { found: T } | { error: string };

/** Finds a thread by id, id prefix, or title, falling back to archived threads, which the shell snapshot omits. */
export async function lookupThread(client: T3Client, selector: string): Promise<OrchestrationThreadShell> {
  const { threads } = await client.shell();
  const active = matchThread(threads, selector);
  if ("found" in active) return active.found;
  const archived = await client.call("orchestration.getArchivedShellSnapshot", {});
  const any = archived.threads.length ? matchThread([...threads, ...archived.threads], selector) : active;
  if ("found" in any) return any.found;
  throw new T3Error(any.error);
}

export function matchThread(threads: readonly OrchestrationThreadShell[], selector: string): Match<OrchestrationThreadShell> {
  return pickUnique(threads, selector, "thread", (thread) => [thread.id, thread.title]);
}

/** Finds a project by id, title, or workspace path (relative paths resolve against the cwd). */
export function resolveProject(shell: OrchestrationShellSnapshot, selector: string): OrchestrationProjectShell {
  const match = pickUnique(shell.projects, selector, "project", (project) => [project.id, project.title, project.workspaceRoot, safeRealpath(project.workspaceRoot)], safeRealpath(resolve(selector)));
  if ("found" in match) return match.found;
  throw new T3Error(match.error);
}

/** Exact matches win, then unique prefix or case-insensitive matches. */
export function pickUnique<T>(items: readonly T[], selector: string, label: string, keys: (item: T) => (string | null)[], alternate?: string | null): Match<T> {
  const exact = items.filter((item) => keys(item).some((key) => key !== null && (key === selector || key === alternate)));
  if (exact.length === 1) return { found: exact[0]! };
  const loose = items.filter((item) => keys(item).some((key) => key !== null && (key.startsWith(selector) || key.toLowerCase() === selector.toLowerCase())));
  if (loose.length === 1) return { found: loose[0]! };
  const candidates = exact.length > 1 ? exact : loose;
  return { error: candidates.length > 1 ? `"${selector}" matches ${candidates.length} ${label}s; use a longer id` : `no ${label} matches "${selector}"` };
}

function safeRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}
