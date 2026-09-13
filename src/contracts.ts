// Wire shapes this CLI depends on. Upstream source of truth:
// pingdotgg/t3code packages/contracts/src/{orchestration,server,auth,assets,environment}.ts
// Only the fields the CLI reads or writes are typed; unknown fields pass through.

export const RUNTIME_MODES = ["approval-required", "auto-accept-edits", "auto", "full-access"] as const;
export type RuntimeMode = (typeof RUNTIME_MODES)[number];
export const INTERACTION_MODES = ["default", "plan"] as const;
export type InteractionMode = (typeof INTERACTION_MODES)[number];
export const APPROVAL_DECISIONS = ["accept", "acceptForSession", "acceptAlways", "decline", "cancel"] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

export type ProviderOptionSelection = { id: string; value: string | boolean };
export type ModelSelection = { instanceId: string; model: string; options?: ProviderOptionSelection[] };

export type ImageUploadAttachment = { type: "image"; name: string; mimeType: string; sizeBytes: number; dataUrl: string };
export type StoredAttachment = { type: "image" | "file"; id: string; name: string; mimeType: string; sizeBytes: number };
export type Attachment = ImageUploadAttachment | StoredAttachment;

type Stamped = { commandId: string; createdAt: string };
type ForThread = Stamped & { threadId: string };

export type ThreadCreateCommand = ForThread & {
  type: "thread.create";
  projectId: string;
  title: string;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: InteractionMode;
  branch: string | null;
  worktreePath: string | null;
};

export type TurnStartBootstrap = {
  createThread?: Omit<ThreadCreateCommand, "type" | "commandId" | "threadId">;
  prepareWorktree?: { projectCwd: string; baseBranch: string; branch?: string; startFromOrigin?: boolean };
  runSetupScript?: boolean;
};

export type ThreadTurnStartCommand = ForThread & {
  type: "thread.turn.start";
  message: { messageId: string; role: "user"; text: string; attachments: Attachment[] };
  modelSelection?: ModelSelection;
  titleSeed?: string;
  runtimeMode: RuntimeMode;
  interactionMode: InteractionMode;
  bootstrap?: TurnStartBootstrap;
  sourceProposedPlan?: { threadId: string; planId: string };
};

export type ThreadMetaUpdateCommand = ForThread & {
  type: "thread.meta.update";
  title?: string;
  regenerateTitle?: true;
  modelSelection?: ModelSelection;
  linkedPullRequest?: { projectId: string; repository: string; number: number; url: string } | null;
};

export type ClientCommand =
  | ThreadCreateCommand
  | ThreadTurnStartCommand
  | ThreadMetaUpdateCommand
  | (ForThread & { type: "thread.runtime-mode.set"; runtimeMode: RuntimeMode })
  | (ForThread & { type: "thread.interaction-mode.set"; interactionMode: InteractionMode })
  | (ForThread & { type: "thread.turn.interrupt"; turnId?: string })
  | (ForThread & { type: "thread.approval.respond"; requestId: string; decision: ApprovalDecision })
  | (ForThread & { type: "thread.user-input.respond"; requestId: string; answers: Record<string, unknown> })
  | (ForThread & { type: "thread.user-input.dismiss"; requestId: string })
  | (ForThread & { type: "thread.checkpoint.revert"; turnCount: number })
  | (ForThread & { type: "thread.session.stop"; onlyIfSettled?: boolean })
  | (ForThread & { type: "thread.snooze"; snoozedUntil: string })
  | (ForThread & { type: "thread.unsnooze" | "thread.unsettle"; reason: "user" })
  | (ForThread & { type: "thread.pin"; orderKey?: string })
  | (ForThread & { type: "thread.delete" | "thread.archive" | "thread.unarchive" | "thread.settle" | "thread.unpin" })
  | (Stamped & { type: "project.create"; projectId: string; title: string; workspaceRoot: string })
  | (Stamped & { type: "project.meta.update"; projectId: string; title?: string; defaultModelSelection?: ModelSelection | null; defaultThreadEnvMode?: "local" | "worktree" | null; autoPull?: boolean })
  | (Stamped & { type: "project.delete"; projectId: string; force?: boolean });

export type DispatchResult = { sequence: number };

export type SessionStatus = "idle" | "starting" | "running" | "ready" | "interrupted" | "stopped" | "error";
export type Session = {
  threadId: string;
  status: SessionStatus;
  providerName: string | null;
  providerInstanceId?: string;
  runtimeMode: RuntimeMode;
  activeTurnId: string | null;
  lastError: string | null;
  updatedAt: string;
};

export type LatestTurnState = "running" | "interrupted" | "completed" | "error";
export type LatestTurn = {
  turnId: string;
  state: LatestTurnState;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  assistantMessageId: string | null;
};

export type ProjectShell = {
  id: string;
  title: string;
  workspaceRoot: string;
  defaultModelSelection: ModelSelection | null;
  defaultThreadEnvMode?: "local" | "worktree" | null;
  createdAt: string;
  updatedAt: string;
};

export type ThreadShell = {
  id: string;
  projectId: string;
  title: string;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: InteractionMode;
  branch: string | null;
  worktreePath: string | null;
  latestTurn: LatestTurn | null;
  session: Session | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  settledAt: string | null;
  snoozedUntil?: string | null;
  pinnedAt?: string | null;
  hasPendingApprovals: boolean;
  hasPendingUserInput: boolean;
  hasActionableProposedPlan: boolean;
};

export type ShellSnapshot = { snapshotSequence: number; projects: ProjectShell[]; threads: ThreadShell[]; updatedAt: string };

export type Message = {
  id: string;
  role: "user" | "assistant" | string;
  text: string;
  attachments?: StoredAttachment[];
  turnId: string | null;
  streaming: boolean;
  createdAt: string;
  updatedAt: string;
};

export type Activity = {
  id: string;
  tone: "info" | "tool" | "approval" | "error";
  kind: string;
  summary: string;
  payload: unknown;
  turnId: string | null;
  sequence?: number;
  createdAt: string;
};

export type ProposedPlan = {
  id: string;
  turnId: string | null;
  planMarkdown: string;
  implementedAt: string | null;
  implementationThreadId: string | null;
  createdAt: string;
};

export type CheckpointSummary = {
  turnId: string;
  checkpointTurnCount: number;
  status: "ready" | "missing" | "error";
  files: { path: string; kind: string; additions: number; deletions: number }[];
  assistantMessageId: string | null;
  completedAt: string;
};

export type ThreadDetail = ThreadShell & {
  messages: Message[];
  proposedPlans: ProposedPlan[];
  activities: Activity[];
  checkpoints: CheckpointSummary[];
};

export type ThreadDetailSnapshot = {
  snapshotSequence: number;
  thread: ThreadDetail;
  page?: { beforeCursor: string | null; hasMore: boolean };
};

export type OrchestrationEvent = {
  sequence: number;
  eventId: string;
  type: string;
  aggregateId: string;
  occurredAt: string;
  commandId: string | null;
  payload: Record<string, unknown>;
};

export type ThreadStreamItem =
  | { kind: "synchronized" }
  | { kind: "snapshot"; snapshot: ThreadDetailSnapshot }
  | { kind: "event"; event: OrchestrationEvent };

export type ProviderOptionDescriptor =
  | { id: string; label: string; type: "select"; options: { id: string; label: string; isDefault?: boolean }[]; currentValue?: string }
  | { id: string; label: string; type: "boolean"; currentValue?: boolean };

export type ProviderModel = {
  slug: string;
  name: string;
  isDefault?: boolean;
  isLegacy?: boolean;
  isCustom: boolean;
  capabilities: { optionDescriptors?: ProviderOptionDescriptor[] } | null;
};

export type Provider = {
  instanceId: string;
  driver: string;
  displayName?: string;
  enabled: boolean;
  installed: boolean;
  version: string | null;
  status: string;
  auth: { status: "authenticated" | "unauthenticated" | "unknown"; email?: string };
  availability?: "available" | "unavailable";
  requiresNewThreadForModelChange?: boolean;
  models: ProviderModel[];
};

export type ServerConfig = {
  environment: EnvironmentDescriptor;
  providers: Provider[];
  settings: { defaultModelSelection?: ModelSelection | null };
};

export type EnvironmentDescriptor = {
  environmentId: string;
  label: string;
  serverVersion: string;
  platform: { os: string; arch: string; machine?: string };
  capabilities: Record<string, unknown>;
};

export type ServerRuntimeState = { version: number; pid: number; port: number; origin: string; devUrl?: string; startedAt: string };

export type AccessTokenResult = { access_token: string; token_type: string; expires_in: number; scope: string };
export type WebSocketTicketResult = { ticket: string; expiresAt: string };
export type UploadUrlResult = { attachmentId: string; relativeUrl: string; expiresAt: number };
export type SearchResult = { matches: { threadId: string; projectId: string; source: string; snippet: string }[] };
export type TurnDiff = { threadId: string; fromTurnCount: number; toTurnCount: number; diff: string };

export const TOKEN_EXCHANGE = {
  grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
  subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
  requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
} as const;

export const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
