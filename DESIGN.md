# t3code-cli design

> 🤖 Opus 5.5 via Claude Code on behalf of Nei Cardoso

`t3c` is a thin TypeScript CLI that creates and drives T3 Code threads over the server's public API.
It is downstream of t3code: no server changes, no forks.

This branch speaks orchestration protocol 2, the protocol on upstream `main` after 0.0.45.
It is built against the nightly tag `v0.0.46-nightly.20261014.3132` (pinned in `package.json` as `config.t3code`), whose contracts and WebSocket surface equal `main` on that date.
Verified on a scratch server from that nightly on 2026-10-15.
The release may still move beyond this nightly; bump the tag and fix what typecheck reports.

## Principles

- Thin client. JSON in, JSON out. No second database, no agent runtime. The server validates every payload.
- No intermediate shapes. Commands build upstream's command types directly, and `--json` prints upstream's data unchanged. Only the text tables reshape it.
- Functional core. `turn.ts`, `model.ts`, and `resolve.ts` are pure and fixture-tested; commands are the I/O shell around them.
- One server operation per command, documented below, so agents can reason about side effects.
- Discover, do not hardcode. Providers, models, and option ids come from the running server.
- T3's own names. Flags mirror the wire fields (`--instance-id`, `--model`, `--option id=value`, `--runtime-mode`, `--interaction-mode`, `--prepare-worktree`). No aliases such as `--effort`.
- Same idiom as the codex and claude handoff skills: prompt on stdin, JSONL on stdout, a stable id to resume, exit code carries the outcome.
- Zero runtime dependencies and no build. Node 22.18+ runs the TypeScript sources directly and ships `fetch`, `WebSocket`, `parseArgs`, and `randomUUID`.

## Decisions

### Types come from upstream contracts

`@t3tools/contracts` is `private: true`, exports TypeScript source, and is never published.
Keeping a hand-typed copy meant a second description of the protocol that drifted silently.
Instead, `scripts/contracts.sh` (run by `npm install` and `npm run typecheck`) sparse-clones `packages/contracts` at the pinned tag into the gitignored `vendor/t3code`, and `tsconfig.json` maps `@t3tools/contracts` to it.

- Imports are `import type` only, so nothing from t3code or Effect ships at runtime.
- WebSocket method types derive from upstream's `WsRpcGroup`: `RpcInput<"server.getConfig">` is the encoded payload, `RpcOutput<…>` the result. `client.call` and `client.stream` are typed by method tag.
- Protocol 2 schemas encode timestamps as `DateTime.Utc`, which the JSON codec writes as ISO strings. `Wire<Schema>` (in `client.ts`) is the encoded type with `DateTime` mapped to `string`; every wire type in the CLI is a `Wire<…>` of an upstream schema.
- Upstream's stream and turn-item unions also admit unknown future types as `{ type: string }`. `StreamItem` in `turn.ts` types only the known arms, so `switch` narrowing works; unknown items still arrive and fall through.
- `effect` is a devDependency at the version t3code's catalog pins for that tag.
- Upgrading means bumping `config.t3code` and fixing what typecheck reports. Bumping to a tag with a new orchestration protocol fails at `PROTOCOL` in `client.ts` on purpose.

### Lineage is prompt content, not a CLI feature

T3 stores no parent/child relationship between threads.
The CLI does not fake one.
When the child should know its origin, the caller prepends it to the prompt; the README and the `t3-handoff` skill show the pattern.
Leaving it out keeps a thread free of cross-contamination.

### All commands go over the WebSocket

Protocol 2 removed HTTP dispatch.
Commands go to WS `orchestration.dispatchCommand`; thread launch and project changes have their own methods (`orchestration.launchThread`, `projects.mutate`).
One socket per process is opened lazily and multiplexed by request id.
HTTP is left for snapshot reads, the WebSocket ticket, file upload bytes, and the unauthenticated environment descriptor.

### Waiting on a run

Protocol 2 models work as runs.
Each user message starts its own run, which records the message as `userMessageId`; a message sent during a run queues behind it.
`turn.ts` folds `orchestration.subscribeThread` items into a `TurnState` with a pure `step` function, then derives the outcome with `outcome`.
The awaited run is chosen by a `Target`:

- `{ messageId }` (`new --wait`, `send --wait`): the run whose `userMessageId` is the message the CLI just sent. The CLI picks the message id, so there is no race between dispatch and subscription.
- `{ current: true }` (`wait`, `close`): the thread's newest active run in the first snapshot, else its newest run. A thread that never ran settles at once as completed.

A run settles on a terminal status (`completed`, `failed`, `interrupted`, `cancelled`, `rolled_back`), or as `needs-input` while a runtime request is pending.
`waiting` is not terminal: it means the provider is done and the checkpoint is being captured.
A restart continuation (`restartContinuationOfRunId`) stands in for the run it continues.

### Title generation

`launchThread` takes `generateTitle`.
`new` sets it only when `--title` was not given.

### Creation source

Commands that create messages carry `createdBy` and `creationSource`.
Upstream has no `cli` source yet, so `t3c` sends `{ createdBy: "user", creationSource: "web" }`, the source the web composer uses.

## Server facts the design rests on

| Fact | Consequence |
| --- | --- |
| `/ws` requires `orchestrationProtocol=2` and answers anything else with `426`. HTTP reads require the header `x-t3-orchestration-protocol: 2`. | `client.ts` sends both. A mismatch is reported from the environment descriptor. |
| Reads are `GET /api/orchestration/shell` and `GET /api/orchestration/threads/:id` (`{ snapshotSequence, projection }`). The HTTP shell always returns `archivedThreads: []`. | Archived threads come from WS `orchestration.getArchivedShellSnapshot`. |
| Dispatch returns only `{ sequence }`. Run outcomes arrive later as events. | `wait` and `watch` use the WebSocket stream `orchestration.subscribeThread`. |
| The WebSocket is Effect RPC over JSON: `{_tag:"Request", id, tag, payload, headers:[]}`. Streams are ack-gated: the server withholds the next `Chunk` until the client sends `{_tag:"Ack", requestId}`. | `T3Client.stream` acks every chunk. Without it a subscription stalls after the first batch. |
| `subscribeThread` sends a `snapshot` (the flat thread projection) then `event` items with `sequence`, plus `synchronized` markers. | The reducer reads runs, runtime requests, and error turn items from the snapshot, then applies `run.*`, `runtime-request.updated`, `turn-item.updated`, and `thread.deleted`. |
| Approvals and questions are `runtimeRequests` with `status: "pending"`. The prompt or questions live on the matching `approval_request` or `user_input_request` turn item. Errors are `error` turn items with `failure.message`. | `pending` joins request and turn item. `wait` reports the run's error. |
| `message.updated` sends the final text with `streaming: false`; the final event can also be empty. | `watch` prints only final, non-empty messages. |
| Provider and model catalog is only on the wire as `ServerConfig.providers` via `server.getConfig` (WebSocket). Each model carries `capabilities.optionDescriptors`. | `providers` and `models` make one WebSocket call. `--option` values are validated against the descriptors. |
| `modelSelection` is `{ instanceId, model, options: [{id, value}] }`. Effort is a per-driver option id: `reasoningEffort` (codex, grok), `effort` (claudeAgent), `variant` (opencode). | `--option id=value` is the only spelling. `t3c models` prints the ids. |
| File restore on `checkpoint.rollback` needs an isolated worktree. A thread on the project root can only rewind the conversation (`restoreFiles: false`). | `revert --keep-files`. |
| Setup scripts are a project setting the server runs itself. | `--run-setup-script` is gone. |
| Bearer tokens live 30 days. No refresh grant. `t3 auth session issue --token-only` mints one from filesystem trust. A pairing token exchanges at `POST /oauth/token`. `POST /api/auth/websocket-ticket` gives a 5-minute ticket for `ws://…/ws?wsTicket=`. | Two login paths, one credentials file, the built-in `WebSocket` works without custom headers. |
| Running servers write `<T3 home>/{userdata,dev}/server-runtime.json` with `pid`, `port`, `origin`. `GET /.well-known/t3/environment` returns `environmentId`, `serverVersion`, `orchestrationProtocolVersion`, `capabilities`. | Local discovery needs no configuration. |
| Attachments, images included, go through `attachments.createUploadUrl` then a `POST` of raw bytes. The message carries `{ type, id, name, mimeType, sizeBytes }`. | `--attach` handles both kinds the same way. |

## Connection and auth

Credentials file: `~/.config/t3code-cli/credentials.json` (override with `T3C_CREDENTIALS`), mode 0600.

```json
{
  "environments": {
    "b09d047e-…": { "label": "cron-data3", "origin": "http://127.0.0.1:3899", "accessToken": "…", "expiresAt": null, "scopes": [] }
  },
  "default": "b09d047e-…"
}
```

Resolution order: `--env` flag, then the `default` entry, then the first entry, then local discovery with `T3C_TOKEN`.

| Command | What it does |
| --- | --- |
| `t3c login --local [--base-dir] [--ttl] [--t3-bin]` | discover via `server-runtime.json`, then `t3 auth session issue --token-only --label … --base-dir …` |
| `t3c login <pairing-url>` | `POST /oauth/token` with `grant_type=…token-exchange`, `subject_token`, `subject_token_type=urn:t3:params:oauth:token-type:environment-bootstrap`, `client_device_type=bot` |
| `t3c login --token <bearer> --origin <url>` | store a token minted elsewhere |
| `t3c envs` | list stored environments |

HTTP requests send `Authorization: Bearer`.
The WebSocket mints a ticket, connects to `/ws?wsTicket=…&clientSurface=cli&orchestrationProtocol=2`, sends one `Request` per call, acks each `Chunk`, and sends `Interrupt` when a call is abandoned.

## Commands and payloads

All ids are client-generated UUIDs.
`client.dispatch` stamps `commandId`; protocol 2 commands carry no `createdAt`.

### Discover

| Command | Call |
| --- | --- |
| `env` | `GET /.well-known/t3/environment` |
| `projects`, `threads [--project] [--archived]` | `GET /api/orchestration/shell`, or `orchestration.getArchivedShellSnapshot` |
| `providers`, `models [instance] [--all]` | WS `server.getConfig` |
| `search <query> [--limit]` | WS `orchestration.searchThreads { query, limit }` |
| `show <thread> [--messages-only]` | `GET /api/orchestration/threads/:id` |
| `pending <thread>` | same projection: pending runtime requests with their prompt or questions |
| `diff [--from-turn-count] [--to-turn-count] [--full]` | WS `orchestration.getTurnDiff` or `orchestration.getFullThreadDiff`; counts are run ordinals |

### Drive

`new` makes one `orchestration.launchThread` call:

```json
{
  "commandId": "<uuid>", "threadId": "<uuid>", "projectId": "…", "title": "<--title or first prompt line>",
  "creationSource": "web", "generateTitle": true,
  "modelSelection": { "instanceId": "codex", "model": "gpt-6-astra", "options": [{ "id": "reasoningEffort", "value": "high" }] },
  "runtimeMode": "full-access", "interactionMode": "default",
  "workspaceStrategy": { "type": "worktree", "baseRef": "main", "branch": "nei/x", "startFromOrigin": true },
  "initialMessage": { "messageId": "<uuid>", "text": "<stdin>", "attachments": [] }
}
```

Without `--prepare-worktree`, `workspaceStrategy` is `{ "type": "root" }`.
`--no-prompt` dispatches a bare `thread.create` instead.

| Command | Payload |
| --- | --- |
| `send <thread> [--from-plan <planId>]` | `message.dispatch { messageId, text, attachments, dispatchMode: { type: "start_immediately" }, createdBy, creationSource, modelSelection?, sourcePlanRef? }`, preceded by `thread.runtime-mode.set` / `thread.interaction-mode.set` when those flags change the thread |
| `wait <thread> [--timeout]` | WS `orchestration.subscribeThread { threadId }`; exit 0 completed, 2 failed, 3 interrupted, cancelled, or rolled back, 4 needs input, 124 timeout |
| `watch <thread> [--raw] [--from <sequence>]` | same subscription, JSONL; `afterSequence` with `--from` |
| `interrupt <thread> [--hold-queue]` | `run.interrupt { runId, holdQueue? }` for the current active run |
| `approve <thread> [<requestId>] --decision <d>` | `runtime-request.respond { requestId, decision }`; the request id defaults to the only pending one |
| `answer <thread> [<requestId>] --answer q=v…` | `runtime-request.respond { requestId, answers }`; `--dismiss` sends `thread.user-input.dismiss` |
| `close <thread>` | `run.interrupt { holdQueue: true }` if a run is active, wait for it, then `thread.settle`. The one composite command, because settle is rejected during a run. |

`wait --json` prints `{ threadId, state, runId, lastError` or `pending, text, files, title }`.

### Change

| Command | Payload |
| --- | --- |
| `set --title` / `--regenerate-title` / `--pull-request` | `thread.metadata.update { title?, regenerateTitle?, linkedPullRequest? }` |
| `set` model flags | `thread.model-selection.set { modelSelection }` |
| `set --runtime-mode` | `thread.runtime-mode.set { runtimeMode }` |
| `set --interaction-mode` | `thread.interaction-mode.set { interactionMode }` |
| `settle`, `archive`, `unarchive`, `pin`, `unpin`, `delete --yes` | the same-named command with only `threadId` |
| `unsettle`, `unsnooze` | `{ reason: "user" }` |
| `snooze --until <iso\|duration>` | `thread.snooze { snoozedUntil }` |
| `stop` | `provider-session.detach` for each of the thread's provider sessions |
| `revert --turn-count <n> [--keep-files]` | `checkpoint.rollback { scopeId, checkpointId, restoreFiles? }` for the checkpoint after run `n` (0 = before the first run) |
| `project-add`, `project-set`, `project-remove` | WS `projects.mutate` with `project.create`, `project.update`, `project.delete` |

Removed in protocol 2: `new --run-setup-script`, `show --turns`, `stop --only-if-settled`.

## Code layout

```text
src/
  bin.ts          command table, help, exit codes
  cli.ts          parseArgs wrapper, flag helpers, enum lists checked against upstream unions, table output
  errors.ts       T3Error and UsageError with exit codes
  client.ts       T3Client: typed WebSocket RPC (call, stream, dispatch) and HTTP
  credentials.ts  credentials file, local discovery, pairing URL parsing
  model.ts        --option parsing, model selection, descriptor validation
  turn.ts         pure run-outcome reducer, event summaries
  resolve.ts      thread and project lookup by id, prefix, title, or path
  attachments.ts  stdin prompt, attachment uploads
  commands/       one file per command group
scripts/contracts.sh  checks out upstream contracts for typecheck
test/
  *.test.ts       fixture-driven runners and unit tests
  fixtures/       <case>.input.json + <case>.expected.json
skills/t3-handoff/SKILL.md
```

The pure core is tested from fixtures without a server.
Turn fixtures are trimmed recordings of live protocol 2 streams.
Live behavior was verified against a scratch nightly server started with `t3 serve --base-dir <tmp> --port <port>`: every command, including `new --wait`, `send --wait`, the approval flow, worktree launches, attachments, interrupt, and `close`.

## Out of scope

- Parent/child links, badges, auto-settle on close. All need server changes; see t3code discussion #8433 and PR #2829.
- Terminal, preview, pull request, and git commands. The API exists; nothing in the handoff use case needs them.
- Local queueing, retry, or scheduling. Dispatch is idempotent by `commandId`; a plain retry of the same payload is safe.
