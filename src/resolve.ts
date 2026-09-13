import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { T3Client, T3Error } from "./client.ts";
import type { ProjectShell, ShellSnapshot, ThreadShell } from "./contracts.ts";

export async function lookupThread(client: T3Client, selector: string): Promise<ThreadShell> {
  const active = await client.shell();
  try {
    return resolveThread(active, selector);
  } catch (error) {
    const archived = (await client.rpc("orchestration.getArchivedShellSnapshot", {})) as ShellSnapshot;
    if (archived.threads.length === 0) throw error;
    return resolveThread({ ...active, threads: [...active.threads, ...archived.threads] }, selector);
  }
}

export function resolveThread(shell: ShellSnapshot, selector: string): ThreadShell {
  return pickUnique(shell.threads, selector, "thread", (thread) => [thread.id, thread.title]);
}

export function resolveProject(shell: ShellSnapshot, selector: string): ProjectShell {
  return pickUnique(shell.projects, selector, "project", (project) => [project.id, project.title, project.workspaceRoot, safeRealpath(project.workspaceRoot)], safeRealpath(resolve(selector)));
}

function pickUnique<T>(items: T[], selector: string, label: string, keys: (item: T) => (string | null)[], alternate?: string | null): T {
  const exact = items.filter((item) => keys(item).some((key) => key !== null && (key === selector || key === alternate)));
  if (exact.length === 1) return exact[0]!;
  const loose = items.filter((item) => keys(item).some((key) => key !== null && (key.startsWith(selector) || key.toLowerCase() === selector.toLowerCase())));
  if (loose.length === 1) return loose[0]!;
  const candidates = exact.length > 1 ? exact : loose;
  if (candidates.length > 1) throw new T3Error(`"${selector}" matches ${candidates.length} ${label}s; use a longer id`);
  throw new T3Error(`no ${label} matches "${selector}"`);
}

function safeRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}
