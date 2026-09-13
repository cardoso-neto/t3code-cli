import type { Activity, LatestTurnState, OrchestrationEvent, Session, SessionStatus, ThreadDetail } from "./contracts.ts";

export type PendingRequest = { kind: "approval" | "user-input"; requestId: string; summary: string; payload: unknown; turnId: string | null };

export type TurnOutcome =
  | { state: "completed" | "error" | "interrupted" | "stopped"; turnId: string | null; lastError: string | null }
  | { state: "needs-input"; turnId: string | null; pending: PendingRequest[] };

export const EXIT_CODE_BY_OUTCOME: Record<TurnOutcome["state"], number> = {
  completed: 0,
  error: 2,
  interrupted: 3,
  stopped: 3,
  "needs-input": 4,
};

const TERMINAL_STATUSES: SessionStatus[] = ["idle", "ready", "interrupted", "stopped", "error"];

export type TurnTracker = {
  sawRunning: boolean;
  session: Session | null;
  pending: Map<string, PendingRequest>;
};

export function trackerFromDetail(thread: ThreadDetail, expectNewTurn: boolean): TurnTracker {
  const pending = new Map<string, PendingRequest>();
  for (const activity of thread.activities) applyActivity(pending, activity);
  const running = thread.session?.status === "running" || thread.session?.status === "starting" || thread.latestTurn?.state === "running";
  return { sawRunning: running && !expectNewTurn, session: thread.session, pending };
}

export function settledOutcome(tracker: TurnTracker, latestTurnState: LatestTurnState | undefined, expectNewTurn: boolean): TurnOutcome | null {
  if (tracker.pending.size > 0) {
    return { state: "needs-input", turnId: tracker.session?.activeTurnId ?? null, pending: [...tracker.pending.values()] };
  }
  if (expectNewTurn && !tracker.sawRunning) return null;
  if (tracker.sawRunning) return null;
  if (!latestTurnState || latestTurnState === "running") return null;
  return { state: latestTurnState, turnId: null, lastError: tracker.session?.lastError ?? null };
}

export function applyEvent(tracker: TurnTracker, event: OrchestrationEvent): TurnOutcome | null {
  if (event.type === "thread.activity-appended") {
    applyActivity(tracker.pending, (event.payload as { activity: Activity }).activity);
    if (tracker.pending.size > 0) {
      return { state: "needs-input", turnId: tracker.session?.activeTurnId ?? null, pending: [...tracker.pending.values()] };
    }
    return null;
  }
  if (event.type !== "thread.session-set") return null;
  const session = (event.payload as { session: Session }).session;
  const previous = tracker.session;
  tracker.session = session;
  if (session.status === "running" || session.status === "starting" || session.activeTurnId) {
    tracker.sawRunning = true;
    return null;
  }
  if (!tracker.sawRunning || !TERMINAL_STATUSES.includes(session.status)) return null;
  const turnId = previous?.activeTurnId ?? null;
  const state = session.status === "error" ? "error" : session.status === "interrupted" ? "interrupted" : session.status === "stopped" ? "stopped" : "completed";
  return { state, turnId, lastError: session.lastError };
}

function applyActivity(pending: Map<string, PendingRequest>, activity: Activity): void {
  const payload = (activity.payload ?? {}) as { requestId?: string };
  const requestId = payload.requestId;
  if (!requestId) return;
  if (activity.kind === "approval.requested") {
    pending.set(requestId, { kind: "approval", requestId, summary: activity.summary, payload: activity.payload, turnId: activity.turnId });
  } else if (activity.kind === "user-input.requested") {
    pending.set(requestId, { kind: "user-input", requestId, summary: activity.summary, payload: activity.payload, turnId: activity.turnId });
  } else if (activity.kind === "approval.resolved" || activity.kind === "user-input.resolved") {
    pending.delete(requestId);
  }
}

export function finalAssistantText(thread: ThreadDetail, turnId: string | null): string {
  const byId = turnId ? thread.messages.filter((message) => message.turnId === turnId && message.role === "assistant") : [];
  const candidates = byId.length > 0 ? byId : thread.messages.filter((message) => message.role === "assistant");
  const last = candidates.at(-1);
  return last?.text ?? "";
}

export type StreamingTexts = Map<string, string>;

export function summarizeEvent(event: OrchestrationEvent, streaming: StreamingTexts = new Map()): Record<string, unknown> | null {
  const payload = event.payload as Record<string, unknown>;
  switch (event.type) {
    case "thread.message-sent": {
      const messageId = String(payload.messageId);
      if (payload.streaming === true) {
        streaming.set(messageId, String(payload.text));
        return null;
      }
      const text = payload.text || streaming.get(messageId) || "";
      streaming.delete(messageId);
      return { type: "message", role: payload.role, text, turnId: payload.turnId, messageId };
    }
    case "thread.activity-appended": {
      const activity = payload.activity as Activity;
      return { type: "activity", kind: activity.kind, tone: activity.tone, summary: activity.summary, turnId: activity.turnId, requestId: (activity.payload as { requestId?: string } | null)?.requestId };
    }
    case "thread.session-set": {
      const session = payload.session as Session;
      return { type: "session", status: session.status, activeTurnId: session.activeTurnId, lastError: session.lastError };
    }
    case "thread.turn-diff-completed":
      return { type: "diff", turnId: payload.turnId, status: payload.status, files: (payload.files as unknown[]).length };
    case "thread.proposed-plan-upserted": {
      const plan = payload.proposedPlan as { id: string; planMarkdown: string };
      return { type: "plan", planId: plan.id, markdown: plan.planMarkdown };
    }
    default:
      return null;
  }
}
