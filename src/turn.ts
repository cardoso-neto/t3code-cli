import type {
  OrchestrationEvent,
  OrchestrationSession,
  OrchestrationThread,
  OrchestrationThreadActivity,
  OrchestrationThreadStreamItem,
} from "@t3tools/contracts";

export type TurnOutcome =
  | { state: "completed" | "error" | "interrupted" | "stopped"; turnId: string | null; lastError: string | null }
  | { state: "needs-input"; turnId: string | null; pending: OrchestrationThreadActivity[] };

export const EXIT_CODE_BY_OUTCOME: Record<TurnOutcome["state"], number> = {
  completed: 0,
  error: 2,
  interrupted: 3,
  stopped: 3,
  "needs-input": 4,
};

/**
 * Which turn to wait on, which decides how to read the stream's opening snapshot.
 * - current: the thread's turn right now; an idle thread has already settled.
 * - next: a turn dispatched after the snapshot was taken, so the snapshot's turn is an older one.
 * - first: the first turn of a thread created by the dispatch; the snapshot may come before or after the turn starts.
 */
export type Awaiting = "current" | "next" | "first";

/** What a thread stream has shown so far about the turn being waited on. */
export type TurnState = {
  awaiting: Awaiting;
  sawRunning: boolean;
  session: OrchestrationSession | null;
  pending: OrchestrationThreadActivity[];
  outcome: TurnOutcome | null;
};

export const initialTurnState = (awaiting: Awaiting): TurnState => ({ awaiting, sawRunning: false, session: null, pending: [], outcome: null });

export function isRunning(thread: Pick<OrchestrationThread, "session" | "latestTurn">): boolean {
  return thread.session?.status === "running" || thread.session?.status === "starting" || thread.latestTurn?.state === "running";
}

/** Open approval and user-input requests: requested activities without a matching resolved one. */
export function pendingRequests(activities: readonly OrchestrationThreadActivity[]): OrchestrationThreadActivity[] {
  return activities.reduce(applyActivity, []);
}

export function requestId(activity: OrchestrationThreadActivity): string | undefined {
  const payload = activity.payload as { requestId?: unknown } | null;
  return typeof payload?.requestId === "string" ? payload.requestId : undefined;
}

function applyActivity(pending: OrchestrationThreadActivity[], activity: OrchestrationThreadActivity): OrchestrationThreadActivity[] {
  const id = requestId(activity);
  if (!id) return pending;
  const others = pending.filter((open) => requestId(open) !== id);
  if (activity.kind === "approval.requested" || activity.kind === "user-input.requested") return [...others, activity];
  if (activity.kind === "approval.resolved" || activity.kind === "user-input.resolved") return others;
  return pending;
}

function needsInput(state: TurnState): TurnState {
  return state.pending.length > 0 ? { ...state, outcome: { state: "needs-input", turnId: state.session?.activeTurnId ?? null, pending: state.pending } } : state;
}

/**
 * Folds one stream item into the state. `outcome` is set once the turn has settled or needs input.
 * A plain subscription opens with a snapshot; one with `afterSequence` replays events instead.
 */
export function step(state: TurnState, item: OrchestrationThreadStreamItem): TurnState {
  if (item.kind === "snapshot") {
    const { thread } = item.snapshot;
    const running = isRunning(thread);
    const next = needsInput({ ...state, session: thread.session, pending: pendingRequests(thread.activities), sawRunning: state.sawRunning || (running && state.awaiting !== "next") });
    if (next.outcome || running || state.awaiting === "next") return next;
    const latest = thread.latestTurn;
    if (!latest && state.awaiting === "first") return next;
    // Idle: report how the latest turn ended, or "completed" for a thread that never ran one.
    const settled = (latest?.state ?? "completed") as "completed" | "error" | "interrupted";
    return { ...next, outcome: { state: settled, turnId: latest?.turnId ?? null, lastError: thread.session?.lastError ?? null } };
  }
  return item.kind === "event" ? applyEvent(state, item.event) : state;
}

function applyEvent(state: TurnState, event: OrchestrationEvent): TurnState {
  if (event.type === "thread.deleted") return { ...state, outcome: { state: "error", turnId: state.session?.activeTurnId ?? null, lastError: "thread was deleted" } };
  if (event.type === "thread.activity-appended") return needsInput({ ...state, pending: applyActivity(state.pending, event.payload.activity) });
  if (event.type !== "thread.session-set") return state;
  const { session } = event.payload;
  const next = { ...state, session };
  if (session.status === "running" || session.status === "starting" || session.activeTurnId) return { ...next, sawRunning: true };
  // An error before the turn ran is a failed start, e.g. worktree preparation.
  if (!state.sawRunning && session.status !== "error") return next;
  const outcome = session.status === "error" || session.status === "interrupted" || session.status === "stopped" ? session.status : "completed";
  return { ...next, outcome: { state: outcome, turnId: state.session?.activeTurnId ?? null, lastError: session.lastError } };
}

/** Consumes a thread stream until the awaited turn settles. Returns null if the stream ends first (timeout or abort). */
export async function waitForTurn(items: AsyncIterable<OrchestrationThreadStreamItem>, awaiting: Awaiting): Promise<TurnOutcome | null> {
  let state = initialTurnState(awaiting);
  for await (const item of items) {
    state = step(state, item);
    if (state.outcome) return state.outcome;
  }
  return null;
}

export function finalAssistantText(thread: Pick<OrchestrationThread, "messages">, turnId: string | null): string {
  const assistant = thread.messages.filter((message) => message.role === "assistant");
  const ofTurn = turnId ? assistant.filter((message) => message.turnId === turnId) : [];
  return (ofTurn.length > 0 ? ofTurn : assistant).at(-1)?.text ?? "";
}

/** Compact view of the events `watch` shows by default. Streamed assistant text is cumulative; `streaming` keeps the latest per message until the final event. */
export function summarizeEvent(event: OrchestrationEvent, streaming: Map<string, string>): Record<string, unknown> | null {
  switch (event.type) {
    case "thread.message-sent": {
      const { messageId, role, text, turnId } = event.payload;
      if (event.payload.streaming) {
        streaming.set(messageId, text);
        return null;
      }
      const final = text || streaming.get(messageId) || "";
      streaming.delete(messageId);
      return { type: "message", role, text: final, turnId, messageId };
    }
    case "thread.activity-appended": {
      const { activity } = event.payload;
      return { type: "activity", kind: activity.kind, tone: activity.tone, summary: activity.summary, turnId: activity.turnId, requestId: requestId(activity) };
    }
    case "thread.session-set": {
      const { session } = event.payload;
      return { type: "session", status: session.status, activeTurnId: session.activeTurnId, lastError: session.lastError };
    }
    case "thread.turn-diff-completed":
      return { type: "diff", turnId: event.payload.turnId, status: event.payload.status, files: event.payload.files.length };
    case "thread.proposed-plan-upserted":
      return { type: "plan", planId: event.payload.proposedPlan.id, markdown: event.payload.proposedPlan.planMarkdown };
    default:
      return null;
  }
}
