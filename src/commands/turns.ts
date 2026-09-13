import { attachmentsFromPaths, readPrompt } from "../attachments.ts";
import { boolFlag, enumFlag, listFlag, positional, requireFlag, stringFlag, type Command, type Context } from "../cli.ts";
import { T3Client, T3Error } from "../client.ts";
import { APPROVAL_DECISIONS, INTERACTION_MODES, RUNTIME_MODES, type LatestTurnState, type ModelSelection, type OrchestrationEvent, type ThreadStreamItem } from "../contracts.ts";
import { buildModelSelection, findModel, parseOptionFlags, validateOptions } from "../model.ts";
import { buildBootstrapTurnStart, buildThreadCommand, buildThreadCreate, buildTurnStart, titleFromPrompt, type NewThreadInput } from "../payloads.ts";
import { lookupThread, resolveProject } from "../resolve.ts";
import { EXIT_CODE_BY_OUTCOME, applyEvent, finalAssistantText, settledOutcome, summarizeEvent, trackerFromDetail, type TurnOutcome } from "../turn.ts";

const MODEL_FLAGS = {
  "instance-id": { type: "string", value: "id", help: "provider instance, e.g. codex, claudeAgent (see: t3c providers)" },
  model: { type: "string", value: "slug", help: "model slug (see: t3c models)" },
  option: { type: "string", value: "id=value", multiple: true, help: "provider option, repeatable, e.g. reasoningEffort=high, effort=max, fastMode=true" },
  "no-validate": { type: "boolean", help: "skip checking --option against the model's descriptors" },
} as const;

const TURN_FLAGS = {
  "prompt-file": { type: "string", value: "path", help: "read the prompt from a file instead of stdin" },
  attach: { type: "string", value: "path", multiple: true, help: "attach a file (png/jpg/gif/webp inline; others uploaded), repeatable" },
  "runtime-mode": { type: "string", value: "mode", help: `one of ${RUNTIME_MODES.join(", ")}` },
  "interaction-mode": { type: "string", value: "mode", help: `one of ${INTERACTION_MODES.join(", ")}` },
  wait: { type: "boolean", help: "block until the turn settles and print the assistant's reply" },
  timeout: { type: "string", value: "duration", help: "with --wait: give up after e.g. 30m, 2h (the turn keeps running)" },
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
    const { client, args, print } = context;
    const shell = await client.shell();
    const project = resolveProject(shell, requireFlag(args, "project"));
    const modelSelection = buildModelSelection(modelFlags(args), project.defaultModelSelection ?? (await serverDefaultModel(client)));
    if (!modelSelection) throw new T3Error("no model selected and the project has no default; pass --instance-id and --model (see: t3c models)", 64);
    await maybeValidate(client, args, modelSelection);
    const noPrompt = boolFlag(args, "no-prompt");
    const text = noPrompt ? "" : await readPrompt(stringFlag(args, "prompt-file"));
    const thread: NewThreadInput = {
      projectId: project.id,
      projectCwd: project.workspaceRoot,
      title: stringFlag(args, "title") ?? titleFromPrompt(text),
      modelSelection,
      runtimeMode: enumFlag(args, "runtime-mode", RUNTIME_MODES, "full-access"),
      interactionMode: enumFlag(args, "interaction-mode", INTERACTION_MODES, "default"),
    };
    if (boolFlag(args, "prepare-worktree")) {
      thread.worktree = { baseBranch: stringFlag(args, "base-branch") ?? "main" };
      const branch = stringFlag(args, "branch");
      if (branch) thread.worktree.branch = branch;
      if (boolFlag(args, "start-from-origin")) thread.worktree.startFromOrigin = true;
      if (boolFlag(args, "run-setup-script")) thread.worktree.runSetupScript = true;
    }
    if (noPrompt) {
      const command = buildThreadCreate(thread);
      const result = await client.dispatch(command);
      print({ threadId: command.threadId, commandId: command.commandId, ...result }, () => command.threadId);
      return;
    }
    const attachments = await attachmentsFromPaths(client, listFlag(args, "attach"));
    const explicitTitle = stringFlag(args, "title");
    const command = buildBootstrapTurnStart(thread, explicitTitle ? { text, attachments } : { text, attachments, titleSeed: thread.title });
    return dispatchTurn(context, command.threadId, command, true);
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
    const { client, args } = context;
    const thread = await lookupThread(client, positional(args, 0, "thread"));
    const modelSelection = buildModelSelection(modelFlags(args), thread.modelSelection);
    if (modelSelection && hasModelFlags(args)) await maybeValidate(client, args, modelSelection);
    const planId = stringFlag(args, "from-plan");
    const text = planId && process.stdin.isTTY && !stringFlag(args, "prompt-file") ? "" : await readPrompt(stringFlag(args, "prompt-file"));
    const attachments = await attachmentsFromPaths(client, listFlag(args, "attach"));
    const command = buildTurnStart(thread.id, {
      text,
      attachments,
      ...(hasModelFlags(args) && modelSelection ? { modelSelection } : {}),
      runtimeMode: enumFlag(args, "runtime-mode", RUNTIME_MODES, thread.runtimeMode),
      interactionMode: enumFlag(args, "interaction-mode", INTERACTION_MODES, thread.interactionMode),
      ...(planId ? { sourceProposedPlan: { threadId: thread.id, planId } } : {}),
    });
    return dispatchTurn(context, thread.id, command, false);
  },
};

function modelFlags(args: Context["args"]) {
  const flags: { instanceId?: string; model?: string; options: ReturnType<typeof parseOptionFlags> } = { options: parseOptionFlags(listFlag(args, "option")) };
  const instanceId = stringFlag(args, "instance-id");
  const model = stringFlag(args, "model");
  if (instanceId) flags.instanceId = instanceId;
  if (model) flags.model = model;
  return flags;
}

function hasModelFlags(args: Context["args"]): boolean {
  return Boolean(stringFlag(args, "instance-id") || stringFlag(args, "model") || listFlag(args, "option").length);
}

async function serverDefaultModel(client: T3Client): Promise<ModelSelection | null> {
  return (await client.config()).settings.defaultModelSelection ?? null;
}

async function maybeValidate(client: T3Client, args: Context["args"], selection: ModelSelection): Promise<void> {
  if (boolFlag(args, "no-validate")) return;
  const { model } = findModel((await client.config()).providers, selection);
  const problems = validateOptions(model, selection.options ?? []);
  if (problems.length) throw new T3Error(`${problems.join("\n")}\n(pass --no-validate to send anyway)`, 64);
}

async function dispatchTurn(context: Context, threadId: string, command: ReturnType<typeof buildTurnStart>, isNew: boolean): Promise<number | void> {
  const { client, args, print } = context;
  if (!boolFlag(args, "wait")) {
    const result = await client.dispatch(command);
    print({ threadId, commandId: command.commandId, messageId: command.message.messageId, ...result }, () => threadId);
    return;
  }
  const controller = new AbortController();
  const stream = client.subscribe("orchestration.subscribeThread", isNew ? { threadId, afterSequence: 0 } : { threadId }, controller.signal);
  const dispatched = isNew ? await client.dispatch(command) : null;
  const iterator = stream[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done) throw new T3Error("thread stream ended before delivering a snapshot");
  if (!isNew) await client.dispatch(command);
  const outcome = await waitForTurn(client, threadId, prependItem(first.value as ThreadStreamItem, iterator), true, stringFlag(args, "timeout"), controller);
  return reportOutcome(context, threadId, outcome, dispatched?.sequence);
}

async function* prependItem(first: ThreadStreamItem, rest: AsyncIterator<unknown>): AsyncGenerator<ThreadStreamItem> {
  yield first;
  while (true) {
    const next = await rest.next();
    if (next.done) return;
    yield next.value as ThreadStreamItem;
  }
}

export async function waitForTurn(client: T3Client, threadId: string, items: AsyncIterable<ThreadStreamItem>, expectNewTurn: boolean, timeout: string | undefined, controller: AbortController): Promise<TurnOutcome | "timeout"> {
  const deadline = timeout ? Date.now() + parseDuration(timeout) : null;
  let tracker = null as ReturnType<typeof trackerFromDetail> | null;
  let latestTurnState: LatestTurnState | undefined;
  const timer = deadline ? setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now())) : null;
  try {
    for await (const item of items) {
      if (item.kind === "snapshot") {
        tracker = trackerFromDetail(item.snapshot.thread, expectNewTurn);
        latestTurnState = item.snapshot.thread.latestTurn?.state;
        const settled = settledOutcome(tracker, latestTurnState, expectNewTurn);
        if (settled) return settled;
      } else if (item.kind === "event" && tracker) {
        const outcome = applyEvent(tracker, item.event as OrchestrationEvent);
        if (outcome) return outcome;
      }
      if (deadline && Date.now() > deadline) return "timeout";
    }
    return "timeout";
  } catch (error) {
    if (controller.signal.aborted) return "timeout";
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
  }
}

async function reportOutcome({ client, print }: Context, threadId: string, outcome: TurnOutcome | "timeout", sequence?: number): Promise<number> {
  if (outcome === "timeout") {
    print({ threadId, state: "timeout" }, () => `timed out waiting on ${threadId}; the turn is still running`);
    return 124;
  }
  const detail = (await client.thread(threadId)).thread;
  const text = finalAssistantText(detail, outcome.turnId ?? detail.latestTurn?.turnId ?? null);
  const checkpoint = detail.checkpoints.at(-1);
  const result = { threadId, ...outcome, sequence, text, files: checkpoint?.files.length ?? 0, title: detail.title };
  print(result, () => {
    if (outcome.state === "needs-input") return `${threadId} is waiting on:\n${outcome.pending.map((request) => `  ${request.kind} ${request.requestId}: ${request.summary}`).join("\n")}\n(use t3c approve or t3c answer)`;
    if (outcome.state === "error") return `${threadId} failed: ${outcome.lastError ?? "unknown error"}\n\n${text}`;
    return text || `${threadId} ${outcome.state}`;
  });
  return EXIT_CODE_BY_OUTCOME[outcome.state];
}

export function parseDuration(input: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/.exec(input.trim());
  if (!match) throw new T3Error(`invalid duration "${input}"; use e.g. 90s, 30m, 2h`, 64);
  const unit = match[2] ?? "s";
  const factor = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit]!;
  return Number(match[1]) * factor;
}

export const wait: Command = {
  name: "wait",
  summary: "Block until the thread's current turn settles. Exit 0 completed, 2 error, 3 interrupted, 4 waiting on approval/input, 124 timeout.",
  usage: "wait <thread> [--timeout <duration>]",
  flags: { timeout: { type: "string", value: "duration", help: "give up after e.g. 30m (the turn keeps running)" } },
  async run(context) {
    const { client, args } = context;
    const thread = await lookupThread(client, positional(args, 0, "thread"));
    const controller = new AbortController();
    const items = client.subscribe("orchestration.subscribeThread", { threadId: thread.id }, controller.signal) as AsyncIterable<ThreadStreamItem>;
    const outcome = await waitForTurn(client, thread.id, items, false, stringFlag(args, "timeout"), controller);
    return reportOutcome(context, thread.id, outcome);
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
  async run({ client, args, printLine }) {
    const thread = await lookupThread(client, positional(args, 0, "thread"));
    const from = stringFlag(args, "from");
    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort());
    const items = client.subscribe("orchestration.subscribeThread", from ? { threadId: thread.id, afterSequence: Number(from) } : { threadId: thread.id }, controller.signal) as AsyncIterable<ThreadStreamItem>;
    const streamingTexts = new Map<string, string>();
    for await (const item of items) {
      if (item.kind === "snapshot") {
        printLine({ type: "snapshot", threadId: thread.id, title: item.snapshot.thread.title, session: item.snapshot.thread.session?.status ?? null, latestTurn: item.snapshot.thread.latestTurn?.state ?? null, sequence: item.snapshot.snapshotSequence });
        continue;
      }
      if (item.kind !== "event") continue;
      if (boolFlag(args, "raw")) {
        printLine(item.event);
        continue;
      }
      const summary = summarizeEvent(item.event as OrchestrationEvent, streamingTexts);
      if (summary) printLine({ sequence: item.event.sequence, at: item.event.occurredAt, ...summary });
    }
  },
};

export const interrupt: Command = {
  name: "interrupt",
  summary: "Interrupt the running turn.",
  usage: "interrupt <thread>",
  async run({ client, args, print }) {
    const thread = await lookupThread(client, positional(args, 0, "thread"));
    const command = buildThreadCommand("thread.turn.interrupt", thread.id, {});
    print(await client.dispatch(command), () => `interrupt requested on ${thread.id}`);
  },
};

export const approve: Command = {
  name: "approve",
  summary: "Respond to an approval request (see: t3c pending).",
  usage: `approve <thread> <requestId> --decision <${APPROVAL_DECISIONS.join("|")}>`,
  flags: { decision: { type: "string", value: "decision", help: APPROVAL_DECISIONS.join(", ") } },
  async run({ client, args, print }) {
    const thread = await lookupThread(client, positional(args, 0, "thread"));
    const decision = enumFlag(args, "decision", APPROVAL_DECISIONS);
    if (!decision) throw new T3Error("--decision is required", 64);
    const command = buildThreadCommand("thread.approval.respond", thread.id, { requestId: positional(args, 1, "requestId"), decision });
    print(await client.dispatch(command), () => `${decision} sent for ${command.requestId}`);
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
  async run({ client, args, print }) {
    const thread = await lookupThread(client, positional(args, 0, "thread"));
    const requestId = positional(args, 1, "requestId");
    if (boolFlag(args, "dismiss")) {
      print(await client.dispatch(buildThreadCommand("thread.user-input.dismiss", thread.id, { requestId })), () => `dismissed ${requestId}`);
      return;
    }
    const answers = Object.fromEntries(parseOptionFlags(listFlag(args, "answer")).map((entry) => [entry.id, entry.value]));
    if (Object.keys(answers).length === 0) throw new T3Error("pass --answer questionId=value or --dismiss", 64);
    print(await client.dispatch(buildThreadCommand("thread.user-input.respond", thread.id, { requestId, answers })), () => `answered ${requestId}`);
  },
};

export const close: Command = {
  name: "close",
  summary: "Interrupt if running, wait for the turn to settle, then settle the thread. Reopen with unsettle or send.",
  usage: "close <thread> [--timeout <duration>]",
  flags: { timeout: { type: "string", value: "duration", help: "give up waiting for the interrupt after e.g. 2m" } },
  async run({ client, args, print }) {
    const thread = await lookupThread(client, positional(args, 0, "thread"));
    const detail = (await client.thread(thread.id)).thread;
    const running = detail.session?.status === "running" || detail.session?.status === "starting" || detail.latestTurn?.state === "running";
    if (running) {
      const controller = new AbortController();
      const items = client.subscribe("orchestration.subscribeThread", { threadId: thread.id }, controller.signal) as AsyncIterable<ThreadStreamItem>;
      await client.dispatch(buildThreadCommand("thread.turn.interrupt", thread.id, {}));
      const outcome = await waitForTurn(client, thread.id, items, false, stringFlag(args, "timeout") ?? "2m", controller);
      if (outcome === "timeout") throw new T3Error(`${thread.id} did not stop in time; not settled`, 124);
    }
    const result = await client.dispatch(buildThreadCommand("thread.settle", thread.id, {}));
    print({ threadId: thread.id, interrupted: running, ...result }, () => `${thread.id} settled${running ? " (after interrupt)" : ""}`);
  },
};
