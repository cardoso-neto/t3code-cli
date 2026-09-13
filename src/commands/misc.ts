import { resolve } from "node:path";
import { boolFlag, enumFlag, positional, stringFlag, type Command } from "../cli.ts";
import { T3Error } from "../client.ts";
import type { TurnDiff } from "../contracts.ts";
import { buildModelSelection, parseOptionFlags } from "../model.ts";
import { buildProjectCommand } from "../payloads.ts";
import { lookupThread, resolveProject } from "../resolve.ts";
import { listFlag } from "../cli.ts";

export const diff: Command = {
  name: "diff",
  summary: "Print the unified diff for a turn range, or the whole thread with --full.",
  usage: "diff <thread> [--from-turn-count <n>] [--to-turn-count <n>] [--full] [--ignore-whitespace]",
  flags: {
    "from-turn-count": { type: "string", value: "n", help: "start of the turn range (default: last checkpoint - 1)" },
    "to-turn-count": { type: "string", value: "n", help: "end of the turn range (default: last checkpoint)" },
    full: { type: "boolean", help: "diff from the start of the thread to --to-turn-count" },
    "ignore-whitespace": { type: "boolean", help: "ignore whitespace changes" },
  },
  async run({ client, args, print }) {
    const thread = await lookupThread(client, positional(args, 0, "thread"));
    const detail = (await client.thread(thread.id)).thread;
    const last = detail.checkpoints.at(-1)?.checkpointTurnCount ?? 0;
    const toTurnCount = Number(stringFlag(args, "to-turn-count") ?? last);
    const ignoreWhitespace = boolFlag(args, "ignore-whitespace");
    const result = boolFlag(args, "full")
      ? ((await client.rpc("orchestration.getFullThreadDiff", { threadId: thread.id, toTurnCount, ignoreWhitespace })) as TurnDiff)
      : ((await client.rpc("orchestration.getTurnDiff", { threadId: thread.id, fromTurnCount: Number(stringFlag(args, "from-turn-count") ?? Math.max(0, toTurnCount - 1)), toTurnCount, ignoreWhitespace })) as TurnDiff);
    print(result, () => result.diff || "(no changes)");
  },
};

export const projectAdd: Command = {
  name: "project-add",
  summary: "Register a directory as a project.",
  usage: "project-add <path> [--title <text>]",
  flags: { title: { type: "string", value: "text", help: "project title (default: directory name)" } },
  async run({ client, args, print }) {
    const workspaceRoot = resolve(positional(args, 0, "path"));
    const command = buildProjectCommand("project.create", { projectId: crypto.randomUUID(), title: stringFlag(args, "title") ?? workspaceRoot.split("/").at(-1)!, workspaceRoot });
    print({ projectId: command.projectId, ...(await client.dispatch(command)) }, () => command.projectId);
  },
};

export const projectSet: Command = {
  name: "project-set",
  summary: "Update a project's title, default model, thread environment mode, or auto-pull.",
  usage: "project-set <project> [--title <text>] [--instance-id <id> --model <slug> --option id=value...] [--clear-default-model] [--default-thread-env-mode <local|worktree>] [--auto-pull <true|false>]",
  flags: {
    title: { type: "string", value: "text", help: "new title" },
    "instance-id": { type: "string", value: "id", help: "default provider instance" },
    model: { type: "string", value: "slug", help: "default model slug" },
    option: { type: "string", value: "id=value", multiple: true, help: "default provider option, repeatable" },
    "clear-default-model": { type: "boolean", help: "remove the default model selection" },
    "default-thread-env-mode": { type: "string", value: "mode", help: "local or worktree" },
    "auto-pull": { type: "string", value: "bool", help: "true or false" },
  },
  async run({ client, args, print }) {
    const project = resolveProject(await client.shell(), positional(args, 0, "project"));
    const fields: Record<string, unknown> = { projectId: project.id };
    const title = stringFlag(args, "title");
    if (title) fields.title = title;
    const instanceId = stringFlag(args, "instance-id");
    const model = stringFlag(args, "model");
    if (instanceId || model || listFlag(args, "option").length) {
      fields.defaultModelSelection = buildModelSelection({ ...(instanceId ? { instanceId } : {}), ...(model ? { model } : {}), options: parseOptionFlags(listFlag(args, "option")) }, project.defaultModelSelection);
    }
    if (boolFlag(args, "clear-default-model")) fields.defaultModelSelection = null;
    const envMode = enumFlag(args, "default-thread-env-mode", ["local", "worktree"] as const);
    if (envMode) fields.defaultThreadEnvMode = envMode;
    const autoPull = stringFlag(args, "auto-pull");
    if (autoPull) fields.autoPull = autoPull === "true";
    if (Object.keys(fields).length === 1) throw new T3Error("nothing to set", 64);
    print(await client.dispatch(buildProjectCommand("project.meta.update", fields as never)), () => `updated ${project.id}`);
  },
};

export const projectRemove: Command = {
  name: "project-remove",
  summary: "Remove a project. Fails if it still has threads unless --force.",
  usage: "project-remove <project> [--force]",
  flags: { force: { type: "boolean", help: "remove even if threads exist" } },
  async run({ client, args, print }) {
    const project = resolveProject(await client.shell(), positional(args, 0, "project"));
    const fields = boolFlag(args, "force") ? { projectId: project.id, force: true } : { projectId: project.id };
    print(await client.dispatch(buildProjectCommand("project.delete", fields)), () => `removed ${project.id}`);
  },
};
