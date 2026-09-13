import { execFile } from "node:child_process";
import { hostname } from "node:os";
import { promisify } from "node:util";
import { boolFlag, stringFlag, type Command } from "../cli.ts";
import { T3Error, fetchEnvironment } from "../client.ts";
import { TOKEN_EXCHANGE, type AccessTokenResult } from "../contracts.ts";
import { credentialsPath, discoverLocalServer, loadCredentials, pairingTokenFromUrl, saveCredentials, type StoredEnvironment } from "../credentials.ts";

const run = promisify(execFile);

export const login: Command = {
  name: "login",
  summary: "Store credentials for a T3 Code environment. Pass a pairing URL, or use --local for a server on this machine.",
  usage: "login [<pairing-url>] [--local] [--token <bearer> --origin <url>] [--label <text>] [--default]",
  needsClient: false,
  flags: {
    local: { type: "boolean", help: "mint a token from the local T3 home with `t3 auth session issue` (filesystem trust)" },
    token: { type: "string", value: "bearer", help: "store an existing bearer token" },
    origin: { type: "string", value: "url", help: "server origin for --token" },
    label: { type: "string", value: "text", help: "client label shown in the server's Connections list" },
    ttl: { type: "string", value: "duration", help: "session lifetime for --local, e.g. 30d (default: the server's default)" },
    default: { type: "boolean", help: "make this environment the default" },
    "t3-bin": { type: "string", value: "path", help: "t3 binary for --local (default: `t3` on PATH)" },
  },
  examples: ["t3c login --local --default", "t3c login 'http://host:3773/pair#token=ABCD2345EFGH'", "t3c login --token \"$TOKEN\" --origin http://127.0.0.1:3773"],
  async run({ args, print }) {
    const label = stringFlag(args, "label") ?? `t3code-cli@${hostname()}`;
    const stored = boolFlag(args, "local")
      ? await loginLocal(stringFlag(args, "base-dir"), label, stringFlag(args, "ttl"), stringFlag(args, "t3-bin") ?? "t3")
      : stringFlag(args, "token")
        ? await loginWithToken(stringFlag(args, "token")!, stringFlag(args, "origin"), label)
        : await loginWithPairingUrl(args.positionals[0], label);
    const file = await loadCredentials();
    file.environments[stored.environmentId] = stored.entry;
    if (boolFlag(args, "default") || !file.default) file.default = stored.environmentId;
    await saveCredentials(file);
    print({ environmentId: stored.environmentId, ...stored.entry, accessToken: undefined, credentialsPath: credentialsPath() }, () =>
      `Stored ${stored.entry.label} (${stored.environmentId}) at ${stored.entry.origin}\n  credentials: ${credentialsPath()}\n  expires: ${stored.entry.expiresAt ?? "unknown"}`);
  },
};

type Stored = { environmentId: string; entry: StoredEnvironment };

async function loginLocal(baseDir: string | undefined, label: string, ttl: string | undefined, t3Bin: string): Promise<Stored> {
  const server = await discoverLocalServer(baseDir);
  const stateBase = server.stateDir.replace(/\/(userdata|dev)$/, "");
  const argv = ["auth", "session", "issue", "--token-only", "--label", label, "--base-dir", stateBase, ...(ttl ? ["--ttl", ttl] : [])];
  const env = { ...process.env };
  delete env.T3_SERVICE_LAUNCHER_CONTEXT;
  delete env.T3_BOOT_SERVICE_UNIT;
  let stdout: string;
  try {
    ({ stdout } = await run(t3Bin, argv, { env }));
  } catch (error) {
    throw new T3Error(`could not run "${t3Bin} ${argv.join(" ")}": ${(error as Error).message}\nInstall t3 (npm i -g t3) or pass --t3-bin`);
  }
  const token = stdout.trim().split("\n").at(-1)?.trim();
  if (!token) throw new T3Error("t3 auth session issue printed no token");
  return {
    environmentId: server.environment.environmentId,
    entry: { label: server.environment.label, origin: server.runtime.origin, accessToken: token, expiresAt: null, scopes: [] },
  };
}

async function loginWithPairingUrl(url: string | undefined, label: string): Promise<Stored> {
  if (!url) throw new T3Error("pass a pairing URL, --local, or --token", 64);
  const { origin, token } = pairingTokenFromUrl(url);
  const body = new URLSearchParams({ ...TOKEN_EXCHANGE, subject_token: token, client_label: label, client_device_type: "bot" });
  const response = await fetch(`${origin}/oauth/token`, { method: "POST", body });
  const result = (await response.json()) as AccessTokenResult & { message?: string };
  if (!response.ok) throw new T3Error(`token exchange failed (${response.status}): ${result.message ?? JSON.stringify(result)}`);
  const environment = await fetchEnvironment(origin);
  return {
    environmentId: environment.environmentId,
    entry: {
      label: environment.label,
      origin,
      accessToken: result.access_token,
      expiresAt: new Date(Date.now() + result.expires_in * 1000).toISOString(),
      scopes: result.scope.split(" "),
    },
  };
}

async function loginWithToken(token: string, origin: string | undefined, _label: string): Promise<Stored> {
  if (!origin) throw new T3Error("--token needs --origin", 64);
  const environment = await fetchEnvironment(origin);
  return { environmentId: environment.environmentId, entry: { label: environment.label, origin, accessToken: token, expiresAt: null, scopes: [] } };
}

export const envs: Command = {
  name: "envs",
  summary: "List stored environments.",
  usage: "envs",
  needsClient: false,
  async run({ print }) {
    const file = await loadCredentials();
    const rows = Object.entries(file.environments).map(([id, env]) => ({ id, label: env.label, origin: env.origin, default: file.default === id, expiresAt: env.expiresAt }));
    print(rows, () => rows.map((row) => `${row.default ? "*" : " "} ${row.id}  ${row.label}  ${row.origin}`).join("\n") || "(none)");
  },
};
