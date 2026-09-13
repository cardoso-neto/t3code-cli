import { randomUUID } from "node:crypto";
import type {
  Attachment,
  ClientCommand,
  InteractionMode,
  ModelSelection,
  RuntimeMode,
  ThreadCreateCommand,
  ThreadTurnStartCommand,
  TurnStartBootstrap,
} from "./contracts.ts";

export type Ids = { commandId?: string; threadId?: string; messageId?: string; createdAt?: string };

function stamp(ids: Ids) {
  return { commandId: ids.commandId ?? randomUUID(), createdAt: ids.createdAt ?? new Date().toISOString() };
}

export type NewThreadInput = {
  projectId: string;
  projectCwd: string;
  title: string;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: InteractionMode;
  worktree?: { baseBranch: string; branch?: string; startFromOrigin?: boolean; runSetupScript?: boolean };
};

export function buildThreadCreate(input: NewThreadInput, ids: Ids = {}): ThreadCreateCommand {
  return {
    type: "thread.create",
    ...stamp(ids),
    threadId: ids.threadId ?? randomUUID(),
    projectId: input.projectId,
    title: input.title,
    modelSelection: input.modelSelection,
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
    branch: null,
    worktreePath: null,
  };
}

export type TurnInput = {
  text: string;
  attachments?: Attachment[];
  modelSelection?: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: InteractionMode;
  titleSeed?: string;
  sourceProposedPlan?: { threadId: string; planId: string };
};

export function buildTurnStart(threadId: string, turn: TurnInput, ids: Ids = {}): ThreadTurnStartCommand {
  const command: ThreadTurnStartCommand = {
    type: "thread.turn.start",
    ...stamp(ids),
    threadId,
    message: { messageId: ids.messageId ?? randomUUID(), role: "user", text: turn.text, attachments: turn.attachments ?? [] },
    runtimeMode: turn.runtimeMode,
    interactionMode: turn.interactionMode,
  };
  if (turn.modelSelection) command.modelSelection = turn.modelSelection;
  if (turn.titleSeed) command.titleSeed = turn.titleSeed;
  if (turn.sourceProposedPlan) command.sourceProposedPlan = turn.sourceProposedPlan;
  return command;
}

export function buildBootstrapTurnStart(thread: NewThreadInput, turn: Omit<TurnInput, "runtimeMode" | "interactionMode">, ids: Ids = {}): ThreadTurnStartCommand {
  const created = buildThreadCreate(thread, ids);
  const { type: _type, commandId: _commandId, threadId, ...createThread } = created;
  const bootstrap: TurnStartBootstrap = { createThread };
  if (thread.worktree) {
    bootstrap.prepareWorktree = { projectCwd: thread.projectCwd, baseBranch: thread.worktree.baseBranch };
    if (thread.worktree.branch) bootstrap.prepareWorktree.branch = thread.worktree.branch;
    if (thread.worktree.startFromOrigin) bootstrap.prepareWorktree.startFromOrigin = true;
    if (thread.worktree.runSetupScript) bootstrap.runSetupScript = true;
  }
  const command = buildTurnStart(
    threadId,
    { ...turn, modelSelection: thread.modelSelection, runtimeMode: thread.runtimeMode, interactionMode: thread.interactionMode },
    { ...ids, commandId: created.commandId, createdAt: created.createdAt },
  );
  command.bootstrap = bootstrap;
  return command;
}

export function buildThreadCommand<T extends Extract<ClientCommand, { threadId: string }>["type"]>(
  type: T,
  threadId: string,
  fields: Omit<Extract<ClientCommand, { type: T }>, "type" | "threadId" | "commandId" | "createdAt">,
  ids: Ids = {},
): Extract<ClientCommand, { type: T }> {
  return { type, ...stamp(ids), threadId, ...fields } as Extract<ClientCommand, { type: T }>;
}

export function buildProjectCommand<T extends Extract<ClientCommand, { projectId: string; type: `project.${string}` }>["type"]>(
  type: T,
  fields: Omit<Extract<ClientCommand, { type: T }>, "type" | "commandId" | "createdAt">,
  ids: Ids = {},
): Extract<ClientCommand, { type: T }> {
  return { type, ...stamp(ids), ...fields } as Extract<ClientCommand, { type: T }>;
}

export function titleFromPrompt(text: string, max = 80): string {
  const firstLine = text.split("\n").map((line) => line.replace(/^#+\s*/, "").trim()).find((line) => line.length > 0) ?? "Untitled thread";
  return firstLine.length > max ? `${firstLine.slice(0, max - 1)}…` : firstLine;
}
