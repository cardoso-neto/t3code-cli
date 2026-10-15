import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { OrchestrationThread, OrchestrationThreadStreamItem } from "@t3tools/contracts";
import { attachmentsFromPaths, readPrompt } from "../attachments.ts";
import { APPROVAL_DECISIONS, INTERACTION_MODES, RUNTIME_MODES, boolFlag, enumFlag, intFlag, listFlag, positional, requireFlag, stringFlag, type Command, type Context } from "../cli.ts";
import type { CommandFields, T3Client } from "../client.ts";
import { EXIT, T3Error, TimeoutError, UsageError } from "../errors.ts";
import { MODEL_FLAGS, checkModel, modelFromFlags, parseKeyValues } from "../model.ts";
import { lookupThread, resolveProject } from "../resolve.ts";
import { EXIT_CODE_BY_OUTCOME, finalAssistantText, isAssistantTextFinal, isRunning, requestId, summarizeEvent, waitForTurn, type TurnOutcome } from "../turn.ts";

const TURN_FLAGS = {
  "prompt-file": { type: "string", value: "path", help: "read the prompt from a file instead of stdin" },
  attach: { type: "string", value: "path", multiple: true, help: "attach a file (png/jpg/gif/webp inline; others uploaded), repeatable" },
  "runtime-mode": { type: "string", value: "mode", help: `one of ${RUNTIME_MODES.join(", ")}` },
  "interaction-mode": { type: "string", value: "mode", help: `one of ${INTERACTION_MODES.join(", ")}` },
  wait: { type: "boolean", help: "block until the turn settles and print the assistant's reply" },
  timeout: { type: "string", value: "duration", help: "give up after e.g. 30m, 2h, exit 124 (the turn keeps running)" },
} as const;

export const newThread: Command = {
  name: "new",
  summary: "Create a thread and start its first turn from the prompt on stdin. One dispatch creates the thread, the optional worktree, and the turn.",
  usage: "new --project <project> [model flags] [--title <text>] [--prepare-worktree ...] [turn flags] [--no-prompt] < prompt.md",
  flags: {
    project: { type: "string", value: "project", help: "project id, title, or workspace path" },
    title: { type: "string", value: "text", help: "thread title (default: first line of the prompt)" },
    "prepare-worktree": { type: "boolean", help: "create a git worktree for this thread" },
    "base-branch": { type: "string", value: "ref", help: "with --prepare-worktree: branch to start from (default: main)" },
    branch: { type: "string", value: "name", help: "with --prepare-worktree: new branch name (default: server-generated)" },
    "start-from-origin": { type: "boolean", help: "with --prepare-worktree: fetch and start from origin/<base-branch>" },
    "run-setup-script": { type: "boolean", help: "with --prepare-worktree: run the project's setup script" },
    "no-prompt": { type: "boolean", help: "create an empty thread only (thread.create), no turn" },
    ...MODEL_FLAGS,
    ...TURN_FLAGS,
  },
  examples: [
    "t3c new --project t3code --instance-id codex --model gpt-6-astra --option reasoningEffort=high < brief.md",
    "t3c new --project . --instance-id claudeAgent --model claude-fable-5-1 --option effort=max --prepare-worktree --branch nei/fix --wait < brief.md",
    "echo 'Summarize README.md' | t3c new --project scratch --json",
  ],
  async run(context) {
    const { args, print } = context;
    const client = await context.client();
    const project = resolveProject(await client.shell(), requireFlag(args, "project"));
    const inherited = project.defaultModelSelection ?? (await client.call("server.getConfig", {})).settings.defaultModelSelection;
    const modelSelection = modelFromFlags(args, inherited) ?? inherited;
    if (!modelSelection) throw new UsageError("no model selected and the project has no default; pass --instance-id and --model (see: t3c models)");
    if (!boolFlag(args, "no-validate")) await checkModel(client, modelSelection);
    const noPrompt = boolFlag(args, "no-prompt");
    const text = noPrompt ? "" : await readPrompt(stringFlag(args, "prompt-file"));
    const explicitTitle = stringFlag(args, "title");
    const threadId = randomUUID();
    const createThread = {
      projectId: project.id,
      title: explicitTitle ?? titleFromPrompt(text),
      modelSelection,
      runtimeMode: enumFlag(args, "runtime-mode", RUNTIME_MODES, "full-access"),
      interactionMode: enumFlag(args, "interaction-mode", INTERACTION_MODES, "default"),
      branch: null,
      worktreePath: null,
      createdAt: new Date().toISOString(),
    };
    if (noPrompt) {
      const result = await client.dispatch({ type: "thread.create", threadId, ...createThread });
      print({ threadId, ...result }, () => threadId);
      return;
    }
    const worktree = boolFlag(args, "prepare-worktree");
    // Sending titleSeed makes the server regenerate the title after the first turn, even over an explicit one.
    return startTurn(context, client, {
      type: "thread.turn.start",
      threadId,
      message: { messageId: randomUUID(), role: "user", text, attachments: await attachmentsFromPaths(client, listFlag(args, "attach")) },
      modelSelection,
      runtimeMode: createThread.runtimeMode,
      interactionMode: createThread.interactionMode,
      titleSeed: explicitTitle ? undefined : createThread.title,
      bootstrap: {
        createThread,
        prepareWorktree: worktree
          ? { projectCwd: project.workspaceRoot, baseBranch: stringFlag(args, "base-branch") ?? "main", branch: stringFlag(args, "branch"), startFromOrigin: boolFlag(args, "start-from-origin") || undefined }
          : undefined,
        runSetupScript: (worktree && boolFlag(args, "run-setup-script")) || undefined,
      },
    });
  },
};

export const send: Command = {
  name: "send",
  summary: "Start a follow-up turn on an existing thread with the prompt on stdin. Model and mode flags override the thread's current settings.",
  usage: "send <thread> [model flags] [turn flags] [--from-plan <planId>] < prompt.md",
  flags: {
    "from-plan": { type: "string", value: "planId", help: "implement a plan this thread proposed (sets sourceProposedPlan)" },
    ...MODEL_FLAGS,
    ...TURN_FLAGS,
  },
  examples: ["echo 'Also cover the reconnect path' | t3c send 8f0a --wait", "t3c send 8f0a --from-plan plan_123 --interaction-mode default --wait < /dev/null"],
  async run(context) {
    const { args } = context;
    const client = await context.client();
    const thread = await lookupThread(client, positional(args, 0, "thread"));
    const modelSelection = modelFromFlags(args, thread.modelSelection);
    if (modelSelection && !boolFlag(args, "no-validate")) await checkModel(client, modelSelection);
    const planId = stringFlag(args, "from-plan");
    const promptFile = stringFlag(args, "prompt-file");
    const text = planId && process.stdin.isTTY && !promptFile ? "" : await readPrompt(promptFile);
    return startTurn(context, client, {
      type: "thread.turn.start",
      threadId: thread.id,
      message: { messageId: randomUUID(), role: "user", text, attachments: await attachmentsFromPaths(client, listFlag(args, "attach")) },
      modelSelection,
      runtimeMode: enumFlag(args, "runtime-mode", RUNTIME_MODES, thread.runtimeMode),
      interactionMode: enumFlag(args, "interaction-mode", INTERACTION_MODES, thread.interactionMode),
      sourceProposedPlan: planId ? { threadId: thread.id, planId } : undefined,
    });
  },
};

export function titleFromPrompt(text: string, max = 80): string {
  const firstLine = text.split("\n").map((line) => line.replace(/^#+\s*/, "").trim()).find((line) => line.length > 0) ?? "Untitled thread";
  return firstLine.length > max ? `${firstLine.slice(0, max - 1)}…` : firstLine;
}

/** Ids that find the thread and message again when the dispatch's acknowledgement or the wait is lost. */
type TurnIds = { threadId: string; messageId?: string };

async function startTurn(context: Context, client: T3Client, command: Extract<CommandFields, { type: "thread.turn.start" }>): Promise<number | void> {
  const { args, print } = context;
  const { threadId } = command;
  const ids = { threadId, messageId: command.message.messageId };
  try {
    if (!boolFlag(args, "wait")) {
      const result = await client.dispatch(command);
      print({ ...ids, ...result }, () => threadId);
      return;
    }
    let items: AsyncIterable<OrchestrationThreadStreamItem>;
    let result: Awaited<ReturnType<T3Client["dispatch"]>>;
    if (command.bootstrap) {
      // The thread does not exist until this dispatch. Replaying from the start yields a snapshot, or only events if the thread is gone again.
      result = await client.dispatch(command);
      items = client.stream("orchestration.subscribeThread", { threadId, afterSequence: 0 });
    } else {
      // Subscribe and take the snapshot first, so the turn's events cannot slip past.
      const stream = client.stream("orchestration.subscribeThread", { threadId });
      const first = await stream.next();
      result = await client.dispatch(command);
      items = prepend(first, stream);
    }
    return await reportOutcome(context, client, ids, await waitForTurn(items, command.bootstrap ? "first" : "next"), result.sequence);
  } catch (error) {
    return reportLost(context, ids, error);
  }
}

async function* prepend<T>(first: IteratorResult<T>, rest: AsyncGenerator<T>): AsyncGenerator<T> {
  if (first.done) return;
  yield first.value;
  yield* rest;
}

/**
 * A timeout prints the ids with state "timeout" and exits 124. Other errors keep their exit code and name the ids.
 * Either way the turn, if the server accepted it, keeps running: `t3c show` tells whether it did, `t3c wait` resumes.
 */
function reportLost({ print }: Context, ids: TurnIds, error: unknown): number {
  const where = `thread ${ids.threadId}${ids.messageId ? `, message ${ids.messageId}` : ""}`;
  if (error instanceof TimeoutError) {
    print({ ...ids, state: "timeout" }, () => `${error.message} (${where}); a started turn keeps running`);
    return EXIT.timeout;
  }
  const message = error instanceof Error ? error.message : String(error);
  throw new T3Error(`${message} (${where})`, error instanceof T3Error ? error.exitCode : EXIT.failure);
}

async function reportOutcome({ print }: Context, client: T3Client, ids: TurnIds, outcome: TurnOutcome, sequence?: number): Promise<number> {
  const { threadId } = ids;
  const thread = await readResult(client, threadId, outcome);
  const text = finalAssistantText(thread, outcome.turnId ?? thread.latestTurn?.turnId ?? null);
  const files = thread.checkpoints.at(-1)?.files.length ?? 0;
  print({ ...ids, ...outcome, sequence, text, files, title: thread.title }, () => {
    if (outcome.state === "needs-input") {
      const lines = outcome.pending.map((activity) => `  ${activity.kind} ${requestId(activity)}: ${activity.summary}`);
      return `${threadId} is waiting on:\n${lines.join("\n")}\n(use t3c approve or t3c answer)`;
    }
    if (outcome.state === "error") return `${threadId} failed: ${outcome.lastError ?? "unknown error"}\n\n${text}`;
    return text || `${threadId} ${outcome.state}`;
  });
  return EXIT_CODE_BY_OUTCOME[outcome.state];
}

const RESULT_POLL_MS = 250;
const RESULT_GRACE_MS = 3000;

/**
 * Reads the thread once the settled turn's assistant text is final. Upstream flushes buffered text right after the turn ends,
 * but some ends (a session that exits or fails) never flush, so this gives up after a short grace and returns what is there.
 */
async function readResult(client: T3Client, threadId: string, outcome: TurnOutcome): Promise<OrchestrationThread> {
  for (let waited = 0; ; waited += RESULT_POLL_MS) {
    const { thread } = await client.thread(threadId);
    const turnId = outcome.turnId ?? thread.latestTurn?.turnId ?? null;
    if (outcome.state === "needs-input" || isAssistantTextFinal(thread, turnId) || waited >= RESULT_GRACE_MS) return thread;
    await sleep(RESULT_POLL_MS);
  }
}

export const wait: Command = {
  name: "wait",
  summary: "Block until the thread's current turn settles. Exit 0 completed, 2 error, 3 interrupted, 4 waiting on approval/input, 124 timeout.",
  usage: "wait <thread> [--timeout <duration>]",
  flags: { timeout: { type: "string", value: "duration", help: "give up after e.g. 30m, exit 124 (the turn keeps running)" } },
  async run(context) {
    const client = await context.client();
    const thread = await lookupThread(client, positional(context.args, 0, "thread"));
    const ids = { threadId: thread.id };
    try {
      return await reportOutcome(context, client, ids, await waitForTurn(client.stream("orchestration.subscribeThread", { threadId: thread.id }), "current"));
    } catch (error) {
      return reportLost(context, ids, error);
    }
  },
};

export const watch: Command = {
  name: "watch",
  summary: "Stream a thread's events as JSONL until interrupted. Default view: messages, activities, session changes, diffs, plans.",
  usage: "watch <thread> [--raw] [--from <sequence>]",
  flags: {
    raw: { type: "boolean", help: "emit every orchestration event unchanged" },
    from: { type: "string", value: "sequence", help: "replay events after this sequence instead of starting live" },
  },
  async run({ client: connect, args, printLine }) {
    const client = await connect();
    const thread = await lookupThread(client, positional(args, 0, "thread"));
    const from = intFlag(args, "from");
    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort());
    const streaming = new Map<string, string>();
    const payload = from === undefined ? { threadId: thread.id } : { threadId: thread.id, afterSequence: from };
    for await (const item of client.stream("orchestration.subscribeThread", payload, controller.signal)) {
      if (item.kind === "snapshot") {
        const { thread: detail, snapshotSequence } = item.snapshot;
        printLine({ type: "snapshot", threadId: detail.id, title: detail.title, session: detail.session?.status ?? null, latestTurn: detail.latestTurn?.state ?? null, sequence: snapshotSequence });
      } else if (item.kind === "event" && boolFlag(args, "raw")) {
        printLine(item.event);
      } else if (item.kind === "event") {
        const summary = summarizeEvent(item.event, streaming);
        if (summary) printLine({ sequence: item.event.sequence, at: item.event.occurredAt, ...summary });
      }
    }
  },
};

export const interrupt: Command = {
  name: "interrupt",
  summary: "Interrupt the running turn.",
  usage: "interrupt <thread>",
  async run({ client: connect, args, print }) {
    const client = await connect();
    const thread = await lookupThread(client, positional(args, 0, "thread"));
    print(await client.dispatch({ type: "thread.turn.interrupt", threadId: thread.id }), () => `interrupt requested on ${thread.id}`);
  },
};

export const approve: Command = {
  name: "approve",
  summary: "Respond to an approval request (see: t3c pending).",
  usage: `approve <thread> <requestId> --decision <${APPROVAL_DECISIONS.join("|")}>`,
  flags: { decision: { type: "string", value: "decision", help: APPROVAL_DECISIONS.join(", ") } },
  async run({ client: connect, args, print }) {
    const decision = enumFlag(args, "decision", APPROVAL_DECISIONS);
    if (!decision) throw new UsageError("--decision is required");
    const client = await connect();
    const thread = await lookupThread(client, positional(args, 0, "thread"));
    const requestId = positional(args, 1, "requestId");
    print(await client.dispatch({ type: "thread.approval.respond", threadId: thread.id, requestId, decision }), () => `${decision} sent for ${requestId}`);
  },
};

export const answer: Command = {
  name: "answer",
  summary: "Answer a user-input request (see: t3c pending). Answers are keyed by question id.",
  usage: "answer <thread> <requestId> --answer <questionId=value>... | --dismiss",
  flags: {
    answer: { type: "string", value: "questionId=value", multiple: true, help: "answer for one question, repeatable" },
    dismiss: { type: "boolean", help: "dismiss the request without answering" },
  },
  async run({ client: connect, args, print }) {
    const requestId = positional(args, 1, "requestId");
    const answers = Object.fromEntries(parseKeyValues("answer", listFlag(args, "answer")).map(({ id, value }) => [id, value]));
    const dismiss = boolFlag(args, "dismiss");
    if (!dismiss && Object.keys(answers).length === 0) throw new UsageError("pass --answer questionId=value or --dismiss");
    const client = await connect();
    const thread = await lookupThread(client, positional(args, 0, "thread"));
    if (dismiss) {
      print(await client.dispatch({ type: "thread.user-input.dismiss", threadId: thread.id, requestId }), () => `dismissed ${requestId}`);
      return;
    }
    print(await client.dispatch({ type: "thread.user-input.respond", threadId: thread.id, requestId, answers }), () => `answered ${requestId}`);
  },
};

export const close: Command = {
  name: "close",
  summary: "Interrupt if running, wait for the turn to settle, then settle the thread. Reopen with unsettle or send.",
  usage: "close <thread> [--timeout <duration>]",
  flags: { timeout: { type: "string", value: "duration", default: "2m", help: "give up after e.g. 2m (default 2m)" } },
  async run({ client: connect, args, print }) {
    const client = await connect();
    const thread = await lookupThread(client, positional(args, 0, "thread"));
    const running = isRunning((await client.thread(thread.id)).thread);
    if (running) {
      const stream = client.stream("orchestration.subscribeThread", { threadId: thread.id });
      const first = await stream.next();
      await client.dispatch({ type: "thread.turn.interrupt", threadId: thread.id });
      await waitForTurn(prepend(first, stream), "current").catch((error: unknown) => {
        throw error instanceof TimeoutError ? new TimeoutError(`${thread.id} did not stop in time; not settled`) : error;
      });
    }
    const result = await client.dispatch({ type: "thread.settle", threadId: thread.id });
    print({ threadId: thread.id, interrupted: running, ...result }, () => `${thread.id} settled${running ? " (after interrupt)" : ""}`);
  },
};
