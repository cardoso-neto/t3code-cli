import { randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import { boolFlag, enumFlag, positional, stringFlag, type Command } from "../cli.ts";
import { UsageError } from "../errors.ts";
import { MODEL_FLAGS, modelFromFlags } from "../model.ts";
import { resolveProject } from "../resolve.ts";

export const projectAdd: Command = {
  name: "project-add",
  summary: "Register a directory as a project.",
  usage: "project-add <path> [--title <text>]",
  flags: { title: { type: "string", value: "text", help: "project title (default: directory name)" } },
  async run({ client: connect, args, print }) {
    const workspaceRoot = resolve(positional(args, 0, "path"));
    const projectId = randomUUID();
    const result = await (await connect()).dispatch({ type: "project.create", projectId, title: stringFlag(args, "title") ?? basename(workspaceRoot), workspaceRoot });
    print({ projectId, ...result }, () => projectId);
  },
};

export const projectSet: Command = {
  name: "project-set",
  summary: "Update a project's title, default model, thread environment mode, or auto-pull.",
  usage: "project-set <project> [--title <text>] [--instance-id <id> --model <slug> --option id=value...] [--clear-default-model] [--default-thread-env-mode <local|worktree>] [--auto-pull <true|false>]",
  flags: {
    title: { type: "string", value: "text", help: "new title" },
    ...MODEL_FLAGS,
    "clear-default-model": { type: "boolean", help: "remove the default model selection" },
    "default-thread-env-mode": { type: "string", value: "mode", help: "local or worktree" },
    "auto-pull": { type: "string", value: "bool", help: "true or false" },
  },
  async run({ client: connect, args, print }) {
    const client = await connect();
    const project = resolveProject(await client.shell(), positional(args, 0, "project"));
    const autoPull = enumFlag(args, "auto-pull", ["true", "false"] as const);
    const fields = {
      title: stringFlag(args, "title"),
      defaultModelSelection: boolFlag(args, "clear-default-model") ? null : modelFromFlags(args, project.defaultModelSelection),
      defaultThreadEnvMode: enumFlag(args, "default-thread-env-mode", ["local", "worktree"] as const),
      autoPull: autoPull && autoPull === "true",
    };
    if (Object.values(fields).every((value) => value === undefined)) throw new UsageError("nothing to set");
    print(await client.dispatch({ type: "project.meta.update", projectId: project.id, ...fields }), () => `updated ${project.id}`);
  },
};

export const projectRemove: Command = {
  name: "project-remove",
  summary: "Remove a project. Fails if it still has threads unless --force.",
  usage: "project-remove <project> [--force]",
  flags: { force: { type: "boolean", help: "remove even if threads exist" } },
  async run({ client: connect, args, print }) {
    const client = await connect();
    const project = resolveProject(await client.shell(), positional(args, 0, "project"));
    print(await client.dispatch({ type: "project.delete", projectId: project.id, force: boolFlag(args, "force") || undefined }), () => `removed ${project.id}`);
  },
};
