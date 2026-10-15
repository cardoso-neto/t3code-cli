import { INTERACTION_MODES, RUNTIME_MODES, boolFlag, enumFlag, intFlag, parseDuration, positional, stringFlag, type Command } from "../cli.ts";
import type { CommandFields, ThreadProjection } from "../client.ts";
import { T3Error, UsageError } from "../errors.ts";
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
  summary: "Detach the thread's provider sessions, stopping their processes. The conversation stays; the next send starts a new session.",
  usage: "stop <thread>",
  async run({ client: connect, args, print }) {
    const client = await connect();
    const thread = await lookupThread(client, positional(args, 0, "thread"));
    const results = [];
    for (const session of (await client.thread(thread.id)).providerSessions) {
      results.push({ providerSessionId: session.id, ...(await client.dispatch({ type: "provider-session.detach", threadId: thread.id, providerSessionId: session.id, reason: "client-requested" })) });
    }
    print(results, () => `detached ${results.length} provider session(s) from ${thread.id}`);
  },
};

export const revert: Command = {
  name: "revert",
  summary: "Roll the thread back to the checkpoint taken after run N (0 = before the first run), restoring files unless --keep-files.",
  usage: "revert <thread> --turn-count <n> [--keep-files]",
  flags: {
    "turn-count": { type: "string", value: "n", help: "run ordinal whose checkpoint to restore" },
    "keep-files": { type: "boolean", help: "rewind only the conversation; required outside an isolated worktree" },
  },
  async run({ client: connect, args, print }) {
    const turnCount = intFlag(args, "turn-count");
    if (turnCount === undefined) throw new UsageError("--turn-count is required");
    const client = await connect();
    const thread = await lookupThread(client, positional(args, 0, "thread"));
    const checkpoint = checkpointAfterRun((await client.thread(thread.id)).checkpoints, turnCount);
    if (!checkpoint) throw new T3Error(`${thread.id} has no ready checkpoint for run ${turnCount}`);
    const restoreFiles = boolFlag(args, "keep-files") ? false : undefined;
    const result = await client.dispatch({ type: "checkpoint.rollback", threadId: thread.id, scopeId: checkpoint.scopeId, checkpointId: checkpoint.id, restoreFiles });
    print({ checkpointId: checkpoint.id, ...result }, () => `rollback to run ${turnCount} requested on ${thread.id}`);
  },
};

/** The ready checkpoint taken after run `ordinal`; 0 is the thread's initial checkpoint. */
export function checkpointAfterRun(checkpoints: ThreadProjection["checkpoints"], ordinal: number) {
  const checkpoint = checkpoints.findLast((candidate) => (ordinal === 0 ? candidate.ordinalWithinScope === 0 && candidate.appRunOrdinal === null : candidate.appRunOrdinal === ordinal));
  return checkpoint?.status === "ready" ? checkpoint : undefined;
}

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
    if (modelSelection && !boolFlag(args, "no-validate")) await checkModel(client, modelSelection);
    const pullRequest = stringFlag(args, "pull-request");
    const meta = {
      title: stringFlag(args, "title"),
      regenerateTitle: boolFlag(args, "regenerate-title") || undefined,
      linkedPullRequest: boolFlag(args, "unlink-pull-request") ? null : pullRequest ? parsePullRequestUrl(pullRequest, thread.projectId) : undefined,
    };
    const runtimeMode = enumFlag(args, "runtime-mode", RUNTIME_MODES);
    const interactionMode = enumFlag(args, "interaction-mode", INTERACTION_MODES);
    const commands: ThreadCommand[] = [
      ...(Object.values(meta).some((value) => value !== undefined) ? [{ type: "thread.metadata.update" as const, threadId: thread.id, ...meta }] : []),
      ...(modelSelection ? [{ type: "thread.model-selection.set" as const, threadId: thread.id, modelSelection }] : []),
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
