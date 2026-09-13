import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { T3Error, fetchEnvironment } from "./client.ts";
import type { EnvironmentDescriptor, ServerRuntimeState } from "./contracts.ts";

export type StoredEnvironment = {
  label: string;
  origin: string;
  accessToken: string;
  expiresAt: string | null;
  scopes: string[];
};

export type CredentialsFile = { environments: Record<string, StoredEnvironment>; default?: string };

export function credentialsPath(): string {
  return process.env.T3C_CREDENTIALS ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "t3code-cli", "credentials.json");
}

export async function loadCredentials(path = credentialsPath()): Promise<CredentialsFile> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as CredentialsFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { environments: {} };
    throw error;
  }
}

export async function saveCredentials(file: CredentialsFile, path = credentialsPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
  await chmod(path, 0o600);
}

export function selectEnvironment(file: CredentialsFile, selector: string | undefined): [string, StoredEnvironment] | null {
  const entries = Object.entries(file.environments);
  if (selector) {
    const match = entries.find(([id, env]) => id === selector || id.startsWith(selector) || env.label === selector || env.origin === selector);
    if (!match) throw new T3Error(`no stored environment matches "${selector}"; run t3c login or t3c envs`);
    return match;
  }
  const preferred = file.default ? file.environments[file.default] : undefined;
  if (file.default && preferred) return [file.default, preferred];
  return entries[0] ?? null;
}

export function candidateStateDirs(baseDir?: string): string[] {
  const bases = baseDir ? [resolve(baseDir)] : [process.env.T3CODE_HOME, join(homedir(), ".t3")].filter((value): value is string => Boolean(value));
  return bases.flatMap((base) => [join(base, "userdata"), join(base, "dev")]);
}

export type DiscoveredServer = { stateDir: string; runtime: ServerRuntimeState; environment: EnvironmentDescriptor };

export async function discoverLocalServer(baseDir?: string): Promise<DiscoveredServer> {
  const checked: string[] = [];
  for (const stateDir of candidateStateDirs(baseDir)) {
    const runtimePath = join(stateDir, "server-runtime.json");
    checked.push(runtimePath);
    const runtime = await readRuntimeState(runtimePath);
    if (!runtime || !isProcessAlive(runtime.pid)) continue;
    try {
      return { stateDir, runtime, environment: await fetchEnvironment(runtime.origin) };
    } catch {
      continue;
    }
  }
  throw new T3Error(`no running T3 Code server found; checked:\n  ${checked.join("\n  ")}`);
}

async function readRuntimeState(path: string): Promise<ServerRuntimeState | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as ServerRuntimeState;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function pairingTokenFromUrl(input: string): { origin: string; token: string } {
  const url = new URL(input);
  const token = new URLSearchParams(url.hash.replace(/^#/, "")).get("token") ?? url.searchParams.get("token");
  if (!token) throw new T3Error("pairing URL has no token; expected …/pair#token=XXXX");
  return { origin: url.origin, token };
}
