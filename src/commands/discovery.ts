import { boolFlag, positional, shortId, stringFlag, table, type Command } from "../cli.ts";
import type { Provider, SearchResult, ShellSnapshot, ThreadShell } from "../contracts.ts";
import { describeModel } from "../model.ts";
import { lookupThread, resolveProject } from "../resolve.ts";
import { trackerFromDetail } from "../turn.ts";

export const env: Command = {
  name: "env",
  summary: "Show the connected environment.",
  usage: "env",
  async run({ client, print }) {
    const environment = await client.environment();
    print({ origin: client.origin, ...environment }, () => `${environment.label} (${environment.environmentId})\n  origin: ${client.origin}\n  server: ${environment.serverVersion} on ${environment.platform.os}/${environment.platform.arch}`);
  },
};

export const projects: Command = {
  name: "projects",
  summary: "List projects.",
  usage: "projects",
  async run({ client, print }) {
    const shell = await client.shell();
    print(shell.projects, () => table(shell.projects.map((project) => ({ id: project.id, title: project.title, workspaceRoot: project.workspaceRoot, defaultModel: project.defaultModelSelection ? `${project.defaultModelSelection.instanceId}/${project.defaultModelSelection.model}` : null })), ["id", "title", "workspaceRoot", "defaultModel"]));
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
  async run({ client, args, print }) {
    const shell = boolFlag(args, "archived") ? ((await client.rpc("orchestration.getArchivedShellSnapshot", {})) as ShellSnapshot) : await client.shell();
    const projectFilter = stringFlag(args, "project");
    const projectId = projectFilter ? resolveProject(await client.shell(), projectFilter).id : undefined;
    const rows = shell.threads.filter((thread) => !projectId || thread.projectId === projectId).map(threadRow);
    print(rows, () => table(rows, ["id", "title", "model", "session", "turn", "flags", "updatedAt"]));
  },
};

function threadRow(thread: ThreadShell) {
  const flags = [thread.hasPendingApprovals && "approval", thread.hasPendingUserInput && "input", thread.hasActionableProposedPlan && "plan", thread.settledAt && "settled", thread.snoozedUntil && "snoozed", thread.pinnedAt && "pinned", thread.archivedAt && "archived"].filter(Boolean).join(",");
  return {
    id: thread.id,
    title: thread.title,
    projectId: thread.projectId,
    model: `${thread.modelSelection.instanceId}/${thread.modelSelection.model}`,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    session: thread.session?.status ?? null,
    turn: thread.latestTurn?.state ?? null,
    flags: flags || null,
    updatedAt: thread.updatedAt,
  };
}

export const providers: Command = {
  name: "providers",
  summary: "List provider instances and their status.",
  usage: "providers",
  async run({ client, print }) {
    const config = await client.config();
    const rows = config.providers.map((provider: Provider) => ({ instanceId: provider.instanceId, driver: provider.driver, enabled: provider.enabled, installed: provider.installed, auth: provider.auth.status, version: provider.version, defaultModel: provider.models.find((model) => model.isDefault)?.slug ?? provider.models[0]?.slug ?? null, models: provider.models.length }));
    print(rows, () => table(rows, ["instanceId", "driver", "enabled", "installed", "auth", "version", "defaultModel", "models"]));
  },
};

export const models: Command = {
  name: "models",
  summary: "List models and their option descriptors. Option ids and values are what --option accepts.",
  usage: "models [<instance-id>] [--all]",
  flags: { all: { type: "boolean", help: "include legacy models and disabled providers" } },
  examples: ["t3c models claudeAgent", "t3c models --json | jq '.[] | select(.model==\"gpt-6-astra\")'"],
  async run({ client, args, print }) {
    const config = await client.config();
    const instanceId = args.positionals[0];
    const all = boolFlag(args, "all");
    const rows = config.providers
      .filter((provider) => (!instanceId || provider.instanceId === instanceId) && (all || provider.enabled))
      .flatMap((provider) => provider.models.filter((model) => all || !model.isLegacy).map((model) => describeModel(provider, model)));
    print(rows, () =>
      rows
        .map((row) => {
          const options = (row.options as { id: string; type: string; values?: string[]; default?: string }[]).map((option) => (option.type === "boolean" ? `${option.id}=true|false` : `${option.id}=${option.values!.join("|")}${option.default ? ` (default ${option.default})` : ""}`));
          return `${row.instanceId}/${row.model}${row.default ? "  [default]" : ""}${options.length ? `\n    --option ${options.join("\n    --option ")}` : ""}`;
        })
        .join("\n"));
  },
};

export const search: Command = {
  name: "search",
  summary: "Full-text search across threads.",
  usage: "search <query> [--limit <n>]",
  flags: { limit: { type: "string", value: "n", help: "max matches, 1-50 (default 20)" } },
  async run({ client, args, print }) {
    const query = positional(args, 0, "query");
    const limit = Number(stringFlag(args, "limit") ?? 20);
    const result = (await client.rpc("orchestration.searchThreads", { query, limit })) as SearchResult;
    print(result.matches, () => table(result.matches.map((match) => ({ threadId: match.threadId, source: match.source, snippet: match.snippet })), ["threadId", "source", "snippet"]));
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
  async run({ client, args, print }) {
    const thread = await lookupThread(client, positional(args, 0, "thread"));
    const turns = stringFlag(args, "turns");
    const detail = (await client.thread(thread.id, turns ? Number(turns) : undefined)).thread;
    const pending = [...trackerFromDetail(detail, false).pending.values()];
    print({ ...detail, pending }, () => {
      const conversation = detail.messages.map((message) => `--- ${message.role} (${message.createdAt})\n${message.text}`).join("\n\n");
      if (boolFlag(args, "messages-only")) return conversation;
      const header = [
        `${detail.title}  [${shortId(detail.id)}]`,
        `  id: ${detail.id}`,
        `  project: ${detail.projectId}`,
        `  model: ${detail.modelSelection.instanceId}/${detail.modelSelection.model} ${JSON.stringify(detail.modelSelection.options ?? [])}`,
        `  modes: ${detail.runtimeMode}, ${detail.interactionMode}`,
        `  workspace: ${detail.worktreePath ?? "(project root)"}${detail.branch ? ` @ ${detail.branch}` : ""}`,
        `  session: ${detail.session?.status ?? "-"}${detail.session?.lastError ? ` (${detail.session.lastError})` : ""}`,
        `  latest turn: ${detail.latestTurn?.state ?? "-"}`,
        `  pending: ${pending.length ? pending.map((request) => `${request.kind} ${request.requestId}`).join(", ") : "none"}`,
        `  plans: ${detail.proposedPlans.map((plan) => `${plan.id}${plan.implementedAt ? " (implemented)" : ""}`).join(", ") || "none"}`,
        `  checkpoints: ${detail.checkpoints.length}`,
      ];
      return `${header.join("\n")}\n\n${conversation}`;
    });
  },
};

export const pending: Command = {
  name: "pending",
  summary: "List open approval and user-input requests on a thread, with the ids that approve and answer need.",
  usage: "pending <thread>",
  async run({ client, args, print }) {
    const thread = await lookupThread(client, positional(args, 0, "thread"));
    const detail = (await client.thread(thread.id)).thread;
    const requests = [...trackerFromDetail(detail, false).pending.values()];
    print(requests, () => (requests.length ? requests.map((request) => `${request.kind}  ${request.requestId}\n  ${request.summary}\n  ${JSON.stringify(request.payload)}`).join("\n") : "(none)"));
  },
};
