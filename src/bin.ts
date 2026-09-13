#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { boolFlag, connect, formatHelp, parseCommandArgs, type Command, type Context } from "./cli.ts";
import { T3Error } from "./client.ts";
import { env, models, pending, projects, providers, search, show, threads } from "./commands/discovery.ts";
import { archive, pin, remove, revert, set, settle, snooze, stop, unarchive, unpin, unsettle, unsnooze } from "./commands/lifecycle.ts";
import { envs, login } from "./commands/login.ts";
import { diff, projectAdd, projectRemove, projectSet } from "./commands/misc.ts";
import { answer, approve, close, interrupt, newThread, send, wait, watch } from "./commands/turns.ts";

const GROUPS: [string, Command[]][] = [
  ["Connect", [login, envs, env]],
  ["Discover", [projects, threads, providers, models, search, show, pending]],
  ["Drive", [newThread, send, wait, watch, interrupt, approve, answer, close]],
  ["Change", [set, settle, unsettle, archive, unarchive, snooze, unsnooze, pin, unpin, stop, revert, remove]],
  ["Inspect", [diff]],
  ["Projects", [projectAdd, projectSet, projectRemove]],
];
const COMMANDS = new Map(GROUPS.flatMap(([, commands]) => commands).map((command) => [command.name, command]));

function rootHelp(): string {
  const width = Math.max(...[...COMMANDS.keys()].map((name) => name.length));
  const lines = ["t3c - drive T3 Code threads from the command line", "", "Usage: t3c <command> [flags]", ""];
  for (const [group, commands] of GROUPS) {
    lines.push(`${group}:`);
    for (const command of commands) lines.push(`  ${command.name.padEnd(width)}  ${command.summary.split(". ")[0]}`);
    lines.push("");
  }
  lines.push("Run `t3c <command> --help` for flags. Prompts are read from stdin.", "", "Handoff example:", "  { echo 'Context: continuing T3 thread 4f20e2b5. Report back in this thread when done.'; cat brief.md; } \\", "    | t3c new --project . --instance-id codex --model gpt-6-astra --option reasoningEffort=high --wait");
  return lines.join("\n");
}

async function main(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;
  if (!name || name === "--help" || name === "-h" || name === "help") {
    process.stdout.write(rootHelp() + "\n");
    return 0;
  }
  if (name === "--version") {
    process.stdout.write(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version + "\n");
    return 0;
  }
  const command = COMMANDS.get(name);
  if (!command) throw new T3Error(`unknown command "${name}"; run t3c --help`, 64);
  const args = parseCommandArgs(rest, command.flags ?? {});
  if (boolFlag(args, "help")) {
    process.stdout.write(formatHelp(command) + "\n");
    return 0;
  }
  const json = boolFlag(args, "json");
  const context: Context = {
    client: command.needsClient === false ? (null as never) : await connect(args),
    json,
    args,
    print: (value, text) => process.stdout.write((json ? JSON.stringify(value, null, 2) : text()) + "\n"),
    printLine: (line) => process.stdout.write(JSON.stringify(line) + "\n"),
  };
  return (await command.run(context)) ?? 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`t3c: ${message}\n`);
    process.exit(error instanceof T3Error ? error.exitCode : 1);
  },
);
