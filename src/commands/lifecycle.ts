import { boolFlag, enumFlag, listFlag, positional, stringFlag, type Command } from "../cli.ts";
import { T3Error } from "../client.ts";
import { INTERACTION_MODES, RUNTIME_MODES, type ClientCommand, type ModelSelection, type ThreadMetaUpdateCommand } from "../contracts.ts";
import { buildModelSelection, findModel, parseOptionFlags, validateOptions } from "../model.ts";
import { buildThreadCommand } from "../payloads.ts";
import { lookupThread } from "../resolve.ts";
import { parseDuration } from "./turns.ts";

type ThreadCommandType = Extract<ClientCommand, { threadId: string }>["type"];

function simpleThreadCommand(name: string, type: ThreadCommandType, summary: string, fields: Record<string, unknown> = {}): Command {
  return {
    name,
    summary,
    usage: `${name} <thread>`,
    async run({ client, args, print }) {
      const thread = await lookupThread(client, positional(args, 0, "thread"));
      const command = buildThreadCommand(type, thread.id, fields as never);
      print({ threadId: thread.id, type, ...(await client.dispatch(command)) }, () => `${type} -> ${thread.id}`);
    },
  };
}

export const settle = simpleThreadCommand("settle", "thread.settle", "Settle a thread (moves it out of the active list and stops its provider session). Rejected while a turn runs; see close.");
export const unsettle = simpleThreadCommand("unsettle", "thread.unsettle", "Return a settled thread to the active list.", { reason: "user" });
export const archive = simpleThreadCommand("archive", "thread.archive", "Archive a thread.");
export const unarchive = simpleThreadCommand("unarchive", "thread.unarchive", "Unarchive a thread.");
export const unsnooze = simpleThreadCommand("unsnooze", "thread.unsnooze", "Unsnooze a thread.", { reason: "user" });
export const pin = simpleThreadCommand("pin", "thread.pin", "Pin a thread.");
export const unpin = simpleThreadCommand("unpin", "thread.unpin", "Unpin a thread.");

export const snooze: Command = {
  name: "snooze",
  summary: "Snooze a thread until a time or for a duration.",
  usage: "snooze <thread> --until <iso-time|duration>",
  flags: { until: { type: "string", value: "when", help: "ISO timestamp or duration from now, e.g. 3h" } },
  async run({ client, args, print }) {
    const thread = await lookupThread(client, positional(args, 0, "thread"));
    const until = stringFlag(args, "until");
    if (!until) throw new T3Error("--until is required", 64);
    const snoozedUntil = /^\d{4}-/.test(until) ? new Date(until).toISOString() : new Date(Date.now() + parseDuration(until)).toISOString();
    print(await client.dispatch(buildThreadCommand("thread.snooze", thread.id, { snoozedUntil })), () => `${thread.id} snoozed until ${snoozedUntil}`);
  },
};

export const stop: Command = {
  name: "stop",
  summary: "Stop the thread's provider session process. The conversation stays; the next send restarts it.",
  usage: "stop <thread> [--only-if-settled]",
  flags: { "only-if-settled": { type: "boolean", help: "no-op unless the thread is settled" } },
  async run({ client, args, print }) {
    const thread = await lookupThread(client, positional(args, 0, "thread"));
    const fields = boolFlag(args, "only-if-settled") ? { onlyIfSettled: true } : {};
    print(await client.dispatch(buildThreadCommand("thread.session.stop", thread.id, fields)), () => `stop requested on ${thread.id}`);
  },
};

export const revert: Command = {
  name: "revert",
  summary: "Restore the workspace to the checkpoint taken after turn N (0 = before the first turn).",
  usage: "revert <thread> --turn-count <n>",
  flags: { "turn-count": { type: "string", value: "n", help: "checkpoint turn count to restore" } },
  async run({ client, args, print }) {
    const thread = await lookupThread(client, positional(args, 0, "thread"));
    const raw = stringFlag(args, "turn-count");
    if (raw === undefined || !/^\d+$/.test(raw)) throw new T3Error("--turn-count must be a non-negative integer", 64);
    print(await client.dispatch(buildThreadCommand("thread.checkpoint.revert", thread.id, { turnCount: Number(raw) })), () => `revert to turn ${raw} requested on ${thread.id}`);
  },
};

export const remove: Command = {
  name: "delete",
  summary: "Delete a thread permanently.",
  usage: "delete <thread> --yes",
  flags: { yes: { type: "boolean", help: "confirm deletion" } },
  async run({ client, args, print }) {
    const thread = await lookupThread(client, positional(args, 0, "thread"));
    if (!boolFlag(args, "yes")) throw new T3Error(`refusing to delete "${thread.title}" (${thread.id}) without --yes`, 64);
    print(await client.dispatch(buildThreadCommand("thread.delete", thread.id, {})), () => `deleted ${thread.id}`);
  },
};

export const set: Command = {
  name: "set",
  summary: "Change a thread's title, model, runtime mode, interaction mode, or linked pull request. Each group is its own command on the wire.",
  usage: "set <thread> [--title <text> | --regenerate-title] [--instance-id <id> --model <slug> --option id=value...] [--runtime-mode <mode>] [--interaction-mode <mode>] [--pull-request <url> | --unlink-pull-request]",
  flags: {
    title: { type: "string", value: "text", help: "new title" },
    "regenerate-title": { type: "boolean", help: "ask the server to regenerate the title" },
    "instance-id": { type: "string", value: "id", help: "provider instance" },
    model: { type: "string", value: "slug", help: "model slug" },
    option: { type: "string", value: "id=value", multiple: true, help: "provider option, repeatable" },
    "no-validate": { type: "boolean", help: "skip checking --option against the model's descriptors" },
    "runtime-mode": { type: "string", value: "mode", help: RUNTIME_MODES.join(", ") },
    "interaction-mode": { type: "string", value: "mode", help: INTERACTION_MODES.join(", ") },
    "pull-request": { type: "string", value: "url", help: "GitHub pull request URL to link" },
    "unlink-pull-request": { type: "boolean", help: "remove the linked pull request" },
  },
  async run({ client, args, print }) {
    const thread = await lookupThread(client, positional(args, 0, "thread"));
    const dispatched: Record<string, unknown>[] = [];
    const meta: Omit<ThreadMetaUpdateCommand, "type" | "threadId" | "commandId" | "createdAt"> = {};
    const title = stringFlag(args, "title");
    if (title) meta.title = title;
    if (boolFlag(args, "regenerate-title")) meta.regenerateTitle = true;
    const modelFlags = { options: parseOptionFlags(listFlag(args, "option")) } as { instanceId?: string; model?: string; options: ReturnType<typeof parseOptionFlags> };
    const instanceId = stringFlag(args, "instance-id");
    const model = stringFlag(args, "model");
    if (instanceId) modelFlags.instanceId = instanceId;
    if (model) modelFlags.model = model;
    if (modelFlags.instanceId || modelFlags.model || modelFlags.options.length) {
      const selection = buildModelSelection(modelFlags, thread.modelSelection) as ModelSelection;
      if (!boolFlag(args, "no-validate")) {
        const { provider, model } = findModel((await client.config()).providers, selection);
        const problems = validateOptions(model, selection.options ?? []);
        if (problems.length) throw new T3Error(problems.join("\n"), 64);
        if (provider.requiresNewThreadForModelChange && selection.instanceId !== thread.modelSelection.instanceId) {
          process.stderr.write(`warning: ${provider.instanceId} requires a new thread for model changes; the next turn may fail\n`);
        }
      }
      meta.modelSelection = selection;
    }
    const pullRequest = stringFlag(args, "pull-request");
    if (pullRequest) meta.linkedPullRequest = parsePullRequestUrl(pullRequest, thread.projectId);
    if (boolFlag(args, "unlink-pull-request")) meta.linkedPullRequest = null;
    if (Object.keys(meta).length) dispatched.push(await dispatch(client, buildThreadCommand("thread.meta.update", thread.id, meta)));
    const runtimeMode = enumFlag(args, "runtime-mode", RUNTIME_MODES);
    if (runtimeMode) dispatched.push(await dispatch(client, buildThreadCommand("thread.runtime-mode.set", thread.id, { runtimeMode })));
    const interactionMode = enumFlag(args, "interaction-mode", INTERACTION_MODES);
    if (interactionMode) dispatched.push(await dispatch(client, buildThreadCommand("thread.interaction-mode.set", thread.id, { interactionMode })));
    if (dispatched.length === 0) throw new T3Error("nothing to set", 64);
    print(dispatched, () => dispatched.map((entry) => `${entry.type} -> sequence ${entry.sequence}`).join("\n"));
  },
};

async function dispatch(client: { dispatch: (command: ClientCommand) => Promise<{ sequence: number }> }, command: ClientCommand): Promise<Record<string, unknown>> {
  return { type: command.type, ...(await client.dispatch(command)) };
}

function parsePullRequestUrl(url: string, projectId: string): { projectId: string; repository: string; number: number; url: string } {
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url);
  if (!match) throw new T3Error(`unrecognized pull request URL "${url}"`, 64);
  return { projectId, repository: match[1]!, number: Number(match[2]), url };
}
