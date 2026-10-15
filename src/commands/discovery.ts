import type { OrchestrationThreadShell } from "@t3tools/contracts";
import { fetchEnvironment } from "../client.ts";
import { boolFlag, intFlag, positional, shortId, stringFlag, table, type Command } from "../cli.ts";
import { describeOptions } from "../model.ts";
import { lookupThread, resolveProject } from "../resolve.ts";
import { pendingRequests, requestId } from "../turn.ts";

export const env: Command = {
  name: "env",
  summary: "Show the connected environment.",
  usage: "env",
  async run({ client: connect, print }) {
    const client = await connect();
    const environment = await fetchEnvironment(client.origin);
    print({ origin: client.origin, ...environment }, () => `${environment.label} (${environment.environmentId})\n  origin: ${client.origin}\n  server: ${environment.serverVersion} on ${environment.platform.os}/${environment.platform.arch}`);
  },
};

export const projects: Command = {
  name: "projects",
  summary: "List projects.",
  usage: "projects",
  async run({ client: connect, print }) {
    const { projects } = await (await connect()).shell();
    print(projects, () =>
      table(
        projects.map((project) => ({ ...project, defaultModel: project.defaultModelSelection && `${project.defaultModelSelection.instanceId}/${project.defaultModelSelection.model}` })),
        ["id", "title", "workspaceRoot", "defaultModel"],
      ));
  },
};

export const threads: Command = {
  name: "threads",
  summary: "List threads. Archived threads are hidden unless --archived is passed.",
  usage: "threads [--project <project>] [--archived]",
  flags: {
    project: { type: "string", value: "project", help: "only threads in this project (id, title, or path)" },
    archived: { type: "boolean", help: "list archived threads instead of active ones" },
  },
  async run({ client: connect, args, print }) {
    const client = await connect();
    const shell = await client.shell();
    const listed = boolFlag(args, "archived") ? (await client.call("orchestration.getArchivedShellSnapshot", {})).threads : shell.threads;
    const projectFilter = stringFlag(args, "project");
    const projectId = projectFilter ? resolveProject(shell, projectFilter).id : undefined;
    const rows = listed.filter((thread) => !projectId || thread.projectId === projectId);
    print(rows, () => table(rows.map(threadRow), ["id", "title", "model", "session", "turn", "flags", "updatedAt"]));
  },
};

function threadRow(thread: OrchestrationThreadShell) {
  const flags = [
    thread.hasPendingApprovals && "approval",
    thread.hasPendingUserInput && "input",
    thread.hasActionableProposedPlan && "plan",
    thread.settledAt && "settled",
    thread.snoozedUntil && "snoozed",
    thread.pinnedAt && "pinned",
    thread.archivedAt && "archived",
  ].filter(Boolean);
  return {
    id: thread.id,
    title: thread.title,
    model: `${thread.modelSelection.instanceId}/${thread.modelSelection.model}`,
    session: thread.session?.status,
    turn: thread.latestTurn?.state,
    flags: flags.join(",") || null,
    updatedAt: thread.updatedAt,
  };
}

export const providers: Command = {
  name: "providers",
  summary: "List provider instances and their status.",
  usage: "providers",
  async run({ client: connect, print }) {
    const { providers } = await (await connect()).call("server.getConfig", {});
    const rows = providers.map((provider) => ({
      ...provider,
      auth: provider.auth.status,
      defaultModel: (provider.models.find((model) => model.isDefault) ?? provider.models[0])?.slug,
      models: provider.models.length,
    }));
    print(providers, () => table(rows, ["instanceId", "driver", "enabled", "installed", "auth", "version", "defaultModel", "models"]));
  },
};

export const models: Command = {
  name: "models",
  summary: "List providers' models and their option descriptors. Option ids and values are what --option accepts.",
  usage: "models [<instance-id>] [--all]",
  flags: { all: { type: "boolean", help: "include legacy models and disabled providers" } },
  examples: ["t3c models claudeAgent", "t3c models --json | jq '.[].models[] | select(.slug==\"gpt-6-astra\")'"],
  async run({ client: connect, args, print }) {
    const { providers } = await (await connect()).call("server.getConfig", {});
    const instanceId = args.positionals[0];
    const all = boolFlag(args, "all");
    const listed = providers
      .filter((provider) => (!instanceId || provider.instanceId === instanceId) && (all || provider.enabled))
      .map((provider) => ({ ...provider, models: provider.models.filter((model) => all || !model.isLegacy) }));
    print(listed, () =>
      listed
        .flatMap((provider) => provider.models.map((model) => [`${provider.instanceId}/${model.slug}${model.isDefault ? "  [default]" : ""}`, ...describeOptions(model).map((option) => `    --option ${option}`)].join("\n")))
        .join("\n"));
  },
};

export const search: Command = {
  name: "search",
  summary: "Full-text search across threads.",
  usage: "search <query> [--limit <n>]",
  flags: { limit: { type: "string", value: "n", help: "max matches, 1-50 (default 20)" } },
  async run({ client: connect, args, print }) {
    const query = positional(args, 0, "query");
    const { matches } = await (await connect()).call("orchestration.searchThreads", { query, limit: intFlag(args, "limit") ?? 20 });
    print(matches, () => table(matches, ["threadId", "source", "snippet"]));
  },
};

export const show: Command = {
  name: "show",
  summary: "Show a thread: metadata, messages, pending requests, plans, and checkpoints.",
  usage: "show <thread> [--turns <n>] [--messages-only]",
  flags: {
    turns: { type: "string", value: "n", help: "only the last n turns" },
    "messages-only": { type: "boolean", help: "print just the conversation" },
  },
  async run({ client: connect, args, print }) {
    const client = await connect();
    const { id } = await lookupThread(client, positional(args, 0, "thread"));
    const { thread } = await client.thread(id, intFlag(args, "turns"));
    const pending = pendingRequests(thread.activities);
    print(thread, () => {
      const conversation = thread.messages.map((message) => `--- ${message.role} (${message.createdAt})\n${message.text}`).join("\n\n");
      if (boolFlag(args, "messages-only")) return conversation;
      const header = [
        `${thread.title}  [${shortId(thread.id)}]`,
        `  id: ${thread.id}`,
        `  project: ${thread.projectId}`,
        `  model: ${thread.modelSelection.instanceId}/${thread.modelSelection.model} ${JSON.stringify(thread.modelSelection.options ?? [])}`,
        `  modes: ${thread.runtimeMode}, ${thread.interactionMode}`,
        `  workspace: ${thread.worktreePath ?? "(project root)"}${thread.branch ? ` @ ${thread.branch}` : ""}`,
        `  session: ${thread.session?.status ?? "-"}${thread.session?.lastError ? ` (${thread.session.lastError})` : ""}`,
        `  latest turn: ${thread.latestTurn?.state ?? "-"}`,
        `  pending: ${pending.map((activity) => `${activity.kind} ${requestId(activity)}`).join(", ") || "none"}`,
        `  plans: ${thread.proposedPlans.map((plan) => `${plan.id}${plan.implementedAt ? " (implemented)" : ""}`).join(", ") || "none"}`,
        `  checkpoints: ${thread.checkpoints.length}`,
      ];
      return `${header.join("\n")}\n\n${conversation}`;
    });
  },
};

export const pending: Command = {
  name: "pending",
  summary: "List open approval and user-input requests on a thread. Each carries the requestId that approve and answer need.",
  usage: "pending <thread>",
  async run({ client: connect, args, print }) {
    const client = await connect();
    const { id } = await lookupThread(client, positional(args, 0, "thread"));
    const requests = pendingRequests((await client.thread(id)).thread.activities);
    print(requests, () => requests.map((activity) => `${activity.kind}  ${requestId(activity)}\n  ${activity.summary}\n  ${JSON.stringify(activity.payload)}`).join("\n") || "(none)");
  },
};

export const diff: Command = {
  name: "diff",
  summary: "Print the unified diff for a turn range, or the whole thread with --full.",
  usage: "diff <thread> [--from-turn-count <n>] [--to-turn-count <n>] [--full] [--ignore-whitespace]",
  flags: {
    "from-turn-count": { type: "string", value: "n", help: "start of the turn range (default: --to-turn-count - 1)" },
    "to-turn-count": { type: "string", value: "n", help: "end of the turn range (default: last checkpoint)" },
    full: { type: "boolean", help: "diff from the start of the thread to --to-turn-count" },
    "ignore-whitespace": { type: "boolean", help: "ignore whitespace changes" },
  },
  async run({ client: connect, args, print }) {
    const client = await connect();
    const { id: threadId } = await lookupThread(client, positional(args, 0, "thread"));
    const toTurnCount = intFlag(args, "to-turn-count") ?? (await client.thread(threadId)).thread.checkpoints.at(-1)?.checkpointTurnCount ?? 0;
    const ignoreWhitespace = boolFlag(args, "ignore-whitespace");
    const result = boolFlag(args, "full")
      ? await client.call("orchestration.getFullThreadDiff", { threadId, toTurnCount, ignoreWhitespace })
      : await client.call("orchestration.getTurnDiff", { threadId, fromTurnCount: intFlag(args, "from-turn-count") ?? Math.max(0, toTurnCount - 1), toTurnCount, ignoreWhitespace });
    print(result, () => result.diff || "(no changes)");
  },
};
