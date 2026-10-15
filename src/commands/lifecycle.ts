import { INTERACTION_MODES, RUNTIME_MODES, boolFlag, enumFlag, intFlag, parseDuration, positional, stringFlag, type Command } from "../cli.ts";
import type { CommandFields } from "../client.ts";
import { UsageError } from "../errors.ts";
import { MODEL_FLAGS, checkModel, modelFromFlags } from "../model.ts";
import { lookupThread } from "../resolve.ts";

type ThreadCommand = Extract<CommandFields, { threadId: string }>;

/** A command that takes only the thread, plus whatever fixed fields the wire type needs. */
function simpleThreadCommand<T extends ThreadCommand["type"]>(name: string, type: T, summary: string, fields: Omit<Extract<ThreadCommand, { type: T }>, "type" | "threadId">): Command {
  return {
    name,
    summary,
    usage: `${name} <thread>`,
    async run({ client: connect, args, print }) {
      const client = await connect();
      const thread = await lookupThread(client, positional(args, 0, "thread"));
      const result = await client.dispatch({ type, threadId: thread.id, ...fields } as ThreadCommand);
      print({ threadId: thread.id, type, ...result }, () => `${type} -> ${thread.id}`);
    },
  };
}

export const settle = simpleThreadCommand("settle", "thread.settle", "Settle a thread (moves it out of the active list and stops its provider session). Rejected while a turn runs; see close.", {});
export const unsettle = simpleThreadCommand("unsettle", "thread.unsettle", "Return a settled thread to the active list.", { reason: "user" });
export const archive = simpleThreadCommand("archive", "thread.archive", "Archive a thread.", {});
export const unarchive = simpleThreadCommand("unarchive", "thread.unarchive", "Unarchive a thread.", {});
export const unsnooze = simpleThreadCommand("unsnooze", "thread.unsnooze", "Unsnooze a thread.", { reason: "user" });
export const pin = simpleThreadCommand("pin", "thread.pin", "Pin a thread.", {});
export const unpin = simpleThreadCommand("unpin", "thread.unpin", "Unpin a thread.", {});

export const snooze: Command = {
  name: "snooze",
  summary: "Snooze a thread until a time or for a duration.",
  usage: "snooze <thread> --until <iso-time|duration>",
  flags: { until: { type: "string", value: "when", help: "ISO timestamp or duration from now, e.g. 3h" } },
  async run({ client: connect, args, print }) {
    const until = stringFlag(args, "until");
    if (!until) throw new UsageError("--until is required");
    const snoozedUntil = new Date(/^\d{4}-/.test(until) ? Date.parse(until) : Date.now() + parseDuration(until)).toISOString();
    const client = await connect();
    const thread = await lookupThread(client, positional(args, 0, "thread"));
    print(await client.dispatch({ type: "thread.snooze", threadId: thread.id, snoozedUntil }), () => `${thread.id} snoozed until ${snoozedUntil}`);
  },
};

export const stop: Command = {
  name: "stop",
  summary: "Stop the thread's provider session process. The conversation stays; the next send restarts it.",
  usage: "stop <thread> [--only-if-settled]",
  flags: { "only-if-settled": { type: "boolean", help: "no-op unless the thread is settled" } },
  async run({ client: connect, args, print }) {
    const client = await connect();
    const thread = await lookupThread(client, positional(args, 0, "thread"));
    const onlyIfSettled = boolFlag(args, "only-if-settled") || undefined;
    print(await client.dispatch({ type: "thread.session.stop", threadId: thread.id, onlyIfSettled }), () => `stop requested on ${thread.id}`);
  },
};

export const revert: Command = {
  name: "revert",
  summary: "Restore the workspace to the checkpoint taken after turn N (0 = before the first turn).",
  usage: "revert <thread> --turn-count <n>",
  flags: { "turn-count": { type: "string", value: "n", help: "checkpoint turn count to restore" } },
  async run({ client: connect, args, print }) {
    const turnCount = intFlag(args, "turn-count");
    if (turnCount === undefined) throw new UsageError("--turn-count is required");
    const client = await connect();
    const thread = await lookupThread(client, positional(args, 0, "thread"));
    print(await client.dispatch({ type: "thread.checkpoint.revert", threadId: thread.id, turnCount }), () => `revert to turn ${turnCount} requested on ${thread.id}`);
  },
};

export const remove: Command = {
  name: "delete",
  summary: "Delete a thread permanently.",
  usage: "delete <thread> --yes",
  flags: { yes: { type: "boolean", help: "confirm deletion" } },
  async run({ client: connect, args, print }) {
    const client = await connect();
    const thread = await lookupThread(client, positional(args, 0, "thread"));
    if (!boolFlag(args, "yes")) throw new UsageError(`refusing to delete "${thread.title}" (${thread.id}) without --yes`);
    print(await client.dispatch({ type: "thread.delete", threadId: thread.id }), () => `deleted ${thread.id}`);
  },
};

export const set: Command = {
  name: "set",
  summary: "Change a thread's title, model, runtime mode, interaction mode, or linked pull request. Each group is its own command on the wire.",
  usage: "set <thread> [--title <text> | --regenerate-title] [--instance-id <id> --model <slug> --option id=value...] [--runtime-mode <mode>] [--interaction-mode <mode>] [--pull-request <url> | --unlink-pull-request]",
  flags: {
    title: { type: "string", value: "text", help: "new title" },
    "regenerate-title": { type: "boolean", help: "ask the server to regenerate the title" },
    ...MODEL_FLAGS,
    "runtime-mode": { type: "string", value: "mode", help: RUNTIME_MODES.join(", ") },
    "interaction-mode": { type: "string", value: "mode", help: INTERACTION_MODES.join(", ") },
    "pull-request": { type: "string", value: "url", help: "GitHub pull request URL to link" },
    "unlink-pull-request": { type: "boolean", help: "remove the linked pull request" },
  },
  async run({ client: connect, args, print }) {
    const client = await connect();
    const thread = await lookupThread(client, positional(args, 0, "thread"));
    const modelSelection = modelFromFlags(args, thread.modelSelection);
    if (modelSelection && !boolFlag(args, "no-validate")) {
      const provider = await checkModel(client, modelSelection);
      if (provider.requiresNewThreadForModelChange && modelSelection.instanceId !== thread.modelSelection.instanceId) {
        process.stderr.write(`warning: ${provider.instanceId} requires a new thread for model changes; the next turn may fail\n`);
      }
    }
    const pullRequest = stringFlag(args, "pull-request");
    const meta = {
      title: stringFlag(args, "title"),
      regenerateTitle: boolFlag(args, "regenerate-title") ? (true as const) : undefined,
      modelSelection,
      linkedPullRequest: boolFlag(args, "unlink-pull-request") ? null : pullRequest ? parsePullRequestUrl(pullRequest, thread.projectId) : undefined,
    };
    const runtimeMode = enumFlag(args, "runtime-mode", RUNTIME_MODES);
    const interactionMode = enumFlag(args, "interaction-mode", INTERACTION_MODES);
    const commands: ThreadCommand[] = [
      ...(Object.values(meta).some((value) => value !== undefined) ? [{ type: "thread.meta.update" as const, threadId: thread.id, ...meta }] : []),
      ...(runtimeMode ? [{ type: "thread.runtime-mode.set" as const, threadId: thread.id, runtimeMode }] : []),
      ...(interactionMode ? [{ type: "thread.interaction-mode.set" as const, threadId: thread.id, interactionMode }] : []),
    ];
    if (commands.length === 0) throw new UsageError("nothing to set");
    const results: { type: string; sequence: number }[] = [];
    for (const command of commands) results.push({ type: command.type, ...(await client.dispatch(command)) });
    print(results, () => results.map((entry) => `${entry.type} -> sequence ${entry.sequence}`).join("\n"));
  },
};

function parsePullRequestUrl(url: string, projectId: string) {
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url);
  if (!match) throw new UsageError(`unrecognized pull request URL "${url}"`);
  return { projectId, repository: match[1]!, number: Number(match[2]), url };
}
