import { parseArgs, type ParseArgsConfig } from "node:util";
import { T3Client, T3Error } from "./client.ts";
import { credentialsPath, discoverLocalServer, loadCredentials, selectEnvironment } from "./credentials.ts";

export type FlagSpec = { type: "string" | "boolean"; multiple?: boolean; help: string; value?: string };
export type Flags = Record<string, FlagSpec>;

export type ParsedArgs = {
  values: Record<string, string | boolean | string[] | undefined>;
  positionals: string[];
};

export type Context = {
  client: T3Client;
  json: boolean;
  args: ParsedArgs;
  print: (json: unknown, text: () => string) => void;
  printLine: (line: unknown) => void;
};

export type Command = {
  name: string;
  summary: string;
  usage: string;
  flags?: Flags;
  needsClient?: false;
  examples?: string[];
  run: (context: Context) => Promise<number | void>;
};

export const GLOBAL_FLAGS: Flags = {
  env: { type: "string", help: "stored environment id, label, or origin (default: the default entry, then local discovery)" },
  "base-dir": { type: "string", help: "T3 home to discover a local server in (default: T3CODE_HOME, then ~/.t3)" },
  json: { type: "boolean", help: "machine-readable output" },
  help: { type: "boolean", help: "show help" },
};

export function parseCommandArgs(argv: string[], flags: Flags): ParsedArgs {
  const options: NonNullable<ParseArgsConfig["options"]> = {};
  for (const [name, spec] of Object.entries({ ...GLOBAL_FLAGS, ...flags })) {
    options[name] = spec.multiple ? { type: spec.type, multiple: true } : { type: spec.type };
  }
  try {
    const parsed = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
    return { values: parsed.values as ParsedArgs["values"], positionals: parsed.positionals };
  } catch (error) {
    throw new T3Error((error as Error).message, 64);
  }
}

export function stringFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.values[name];
  return typeof value === "string" ? value : undefined;
}

export function requireFlag(args: ParsedArgs, name: string): string {
  const value = stringFlag(args, name);
  if (!value) throw new T3Error(`--${name} is required`, 64);
  return value;
}

export function boolFlag(args: ParsedArgs, name: string): boolean {
  return args.values[name] === true;
}

export function listFlag(args: ParsedArgs, name: string): string[] {
  const value = args.values[name];
  return Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
}

export function positional(args: ParsedArgs, index: number, label: string): string {
  const value = args.positionals[index];
  if (!value) throw new T3Error(`missing <${label}>`, 64);
  return value;
}

export function enumFlag<T extends string>(args: ParsedArgs, name: string, allowed: readonly T[], fallback: T): T;
export function enumFlag<T extends string>(args: ParsedArgs, name: string, allowed: readonly T[]): T | undefined;
export function enumFlag<T extends string>(args: ParsedArgs, name: string, allowed: readonly T[], fallback?: T): T | undefined {
  const value = stringFlag(args, name);
  if (value === undefined) return fallback;
  if (!allowed.includes(value as T)) throw new T3Error(`--${name} must be one of ${allowed.join(", ")}`, 64);
  return value as T;
}

export async function connect(args: ParsedArgs): Promise<T3Client> {
  const file = await loadCredentials();
  const selected = selectEnvironment(file, stringFlag(args, "env"));
  if (selected) return new T3Client(selected[1].origin, selected[1].accessToken);
  const baseDir = stringFlag(args, "base-dir");
  const tokenFromEnv = process.env.T3C_TOKEN;
  if (tokenFromEnv) {
    const server = await discoverLocalServer(baseDir);
    return new T3Client(server.runtime.origin, tokenFromEnv);
  }
  throw new T3Error(`no credentials at ${credentialsPath()}; run "t3c login --local" or "t3c login <pairing-url>"`);
}

export function formatHelp(command: Command): string {
  const lines = [`t3c ${command.usage}`, "", command.summary, ""];
  const flags = Object.entries({ ...(command.flags ?? {}), ...GLOBAL_FLAGS });
  const width = Math.max(...flags.map(([name, spec]) => name.length + (spec.value ? spec.value.length + 3 : 0)));
  lines.push("Flags:");
  for (const [name, spec] of flags) {
    const label = spec.value ? `--${name} <${spec.value}>` : `--${name}`;
    lines.push(`  ${label.padEnd(width + 3)}  ${spec.help}`);
  }
  if (command.examples?.length) lines.push("", "Examples:", ...command.examples.map((example) => `  ${example}`));
  return lines.join("\n");
}

export function table(rows: Record<string, unknown>[], columns: string[]): string {
  if (rows.length === 0) return "(none)";
  const cells = rows.map((row) => columns.map((column) => formatCell(row[column])));
  const widths = columns.map((column, index) => Math.max(column.length, ...cells.map((row) => row[index]!.length)));
  const line = (values: string[]) => values.map((value, index) => value.padEnd(widths[index]!)).join("  ").trimEnd();
  return [line(columns), ...cells.map(line)].join("\n");
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}
