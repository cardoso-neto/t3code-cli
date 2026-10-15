import type { OrchestrationV2DomainEvent, OrchestrationV2Run, OrchestrationV2RuntimeRequest, OrchestrationV2TurnItem } from "@t3tools/contracts";
import type { RpcOutput, ThreadProjection, Wire } from "./client.ts";

export type Run = Wire<typeof OrchestrationV2Run>;
export type RuntimeRequest = Wire<typeof OrchestrationV2RuntimeRequest>;
export type TurnItem = Wire<typeof OrchestrationV2TurnItem>;
/**
 * Upstream's wire union also admits events and turn items of types this client does not know,
 * typed `{ type: string }`, which defeats narrowing. Type the known arms; unknown ones still
 * arrive at runtime and fall through every `type` check.
 */
export type StreamItem = Exclude<RpcOutput<"orchestration.subscribeThread">, { kind: "event" }> | { kind: "event"; sequence: number; event: Wire<typeof OrchestrationV2DomainEvent> };
type TerminalStatus = Extract<Run["status"], "completed" | "failed" | "interrupted" | "cancelled" | "rolled_back">;

export type TurnOutcome =
  | { state: TerminalStatus; runId: string | null; lastError: string | null }
  | { state: "needs-input"; runId: string; pending: RuntimeRequest[] };

export const EXIT_CODE_BY_OUTCOME: Record<TurnOutcome["state"], number> = {
  completed: 0,
  failed: 2,
  interrupted: 3,
  cancelled: 3,
  rolled_back: 3,
  "needs-input": 4,
};

const TERMINAL: ReadonlySet<Run["status"]> = new Set<TerminalStatus>(["completed", "failed", "interrupted", "cancelled", "rolled_back"]);
export const isActive = (run: Run): boolean => !TERMINAL.has(run.status);

/**
 * The run to wait on: the one the message we sent starts, or whatever run the thread is on
 * when the first snapshot arrives. Restart continuations stand in for the run they continue.
 */
export type Target = { messageId: string } | { current: true };

/** What a thread stream has shown so far, keyed by id. */
export type TurnState = {
  target: Target;
  runs: Record<string, Run>;
  requests: Record<string, RuntimeRequest>;
  errors: Record<string, string>;
  /** Resolved from `{ current: true }` at the first snapshot; null for a thread that never ran. */
  currentRunId?: string | null;
  deleted: boolean;
};

export const initialTurnState = (target: Target): TurnState => ({ target, runs: {}, requests: {}, errors: {}, deleted: false });

export function step(state: TurnState, item: StreamItem): TurnState {
  if (item.kind === "snapshot") {
    const { projection } = item;
    const next = { ...state, runs: byId(projection.runs), requests: byId(projection.runtimeRequests), errors: errorsByRun(projection.turnItems as readonly TurnItem[]) };
    return "current" in state.target && state.currentRunId === undefined ? { ...next, currentRunId: currentRun(projection.runs)?.id ?? null } : next;
  }
  if (item.kind !== "event") return state;
  const { event } = item;
  switch (event.type) {
    case "run.created":
    case "run.updated":
      return { ...state, runs: { ...state.runs, [event.payload.id]: event.payload } };
    case "runtime-request.updated":
      return { ...state, requests: { ...state.requests, [event.payload.id]: event.payload } };
    case "turn-item.updated":
      return { ...state, errors: { ...state.errors, ...errorsByRun([event.payload]) } };
    case "thread.deleted":
      return { ...state, deleted: true };
    default:
      return state;
  }
}

/** The settled outcome, or null while the awaited run is still going. */
export function outcome(state: TurnState): TurnOutcome | null {
  const run = trackedRun(state);
  if (state.deleted) return { state: "failed", runId: run?.id ?? null, lastError: "thread was deleted" };
  if (!run) return "current" in state.target && state.currentRunId === null ? { state: "completed", runId: null, lastError: null } : null;
  if (!isActive(run)) return { state: run.status as TerminalStatus, runId: run.id, lastError: state.errors[run.id] ?? null };
  const pending = Object.values(state.requests).filter((request) => request.status === "pending");
  return pending.length > 0 ? { state: "needs-input", runId: run.id, pending } : null;
}

function trackedRun(state: TurnState): Run | undefined {
  const runs = Object.values(state.runs);
  const { target } = state;
  let run = "messageId" in target ? runs.find((candidate) => candidate.userMessageId === target.messageId) : state.currentRunId ? state.runs[state.currentRunId] : undefined;
  for (let next = run; next; next = runs.find((candidate) => candidate.restartContinuationOfRunId === run!.id)) run = next;
  return run;
}

/** The active run with the highest ordinal, else the latest run. */
export function currentRun(runs: readonly Run[]): Run | undefined {
  const latestFirst = [...runs].sort((a, b) => b.ordinal - a.ordinal);
  return latestFirst.find(isActive) ?? latestFirst[0];
}

function byId<T extends { id: string }>(items: readonly T[]): Record<string, T> {
  return Object.fromEntries(items.map((item) => [item.id, item]));
}

function errorsByRun(items: readonly TurnItem[]): Record<string, string> {
  return Object.fromEntries(items.flatMap((item) => (item.type === "error" && item.runId ? [[item.runId, item.failure.message]] : [])));
}

/** Consumes a thread stream until the awaited run settles. Returns null if the stream ends first (timeout or abort). */
export async function waitForTurn(items: AsyncIterable<RpcOutput<"orchestration.subscribeThread">>, target: Target): Promise<TurnOutcome | null> {
  let state = initialTurnState(target);
  for await (const item of items) {
    state = step(state, item as StreamItem);
    const settled = outcome(state);
    if (settled) return settled;
  }
  return null;
}

export function finalAssistantText(projection: Pick<ThreadProjection, "messages">, runId: string | null): string {
  const assistant = projection.messages.filter((message) => message.role === "assistant");
  const ofRun = runId ? assistant.filter((message) => message.runId === runId) : [];
  return (ofRun.length > 0 ? ofRun : assistant).at(-1)?.text ?? "";
}

/** Open requests joined with the turn item that carries their prompt or questions. */
export function pendingRequests(projection: Pick<ThreadProjection, "runtimeRequests" | "turnItems">): { request: RuntimeRequest; item: TurnItem | undefined }[] {
  return projection.runtimeRequests
    .filter((request) => request.status === "pending")
    .map((request) => ({ request, item: (projection.turnItems as readonly TurnItem[]).find((item) => "requestId" in item && item.requestId === request.id) }));
}

/** Compact view of the events `watch` shows by default. */
export function summarizeEvent(item: Extract<StreamItem, { kind: "event" }>): Record<string, unknown> | null {
  const { event } = item;
  switch (event.type) {
    case "run.created":
    case "run.updated":
      return { type: "run", runId: event.payload.id, ordinal: event.payload.ordinal, status: event.payload.status };
    case "message.updated":
      return event.payload.streaming || !event.payload.text ? null : { type: "message", role: event.payload.role, text: event.payload.text, runId: event.payload.runId, messageId: event.payload.id };
    case "runtime-request.updated":
      return { type: "request", requestId: event.payload.id, kind: event.payload.kind, status: event.payload.status };
    case "turn-item.updated": {
      const turnItem = event.payload;
      if (turnItem.type === "error") return { type: "error", runId: turnItem.runId, message: turnItem.failure.message, code: turnItem.failure.code };
      if (turnItem.type === "proposed_plan" && !turnItem.streaming) return { type: "plan", planId: turnItem.planId, markdown: turnItem.markdown };
      return null;
    }
    case "checkpoint.captured":
      return { type: "checkpoint", runId: event.payload.runId, files: event.payload.files.length };
    case "thread.deleted":
      return { type: "deleted" };
    default:
      return null;
  }
}
