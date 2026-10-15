# t3code-cli design

> 🤖 Opus 5.5 via Claude Code on behalf of Nei Cardoso

`t3c` is a thin TypeScript CLI that creates and drives T3 Code threads over the server's public API.
It is downstream of t3code: no server changes, no forks.

Built against t3code `v0.0.45` (pinned in `package.json` as `config.t3code`) and verified on a scratch `0.0.45` server on 2026-10-15.

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
- `effect` is a devDependency at the version t3code's catalog pins for that tag.
- Upgrading means bumping `config.t3code` and fixing what typecheck reports. Bumping to a tag with a new orchestration protocol fails at `PROTOCOL` in `client.ts` on purpose.

### Lineage is prompt content, not a CLI feature

T3 stores no parent/child relationship between threads.
The CLI does not fake one.
When the child should know its origin, the caller prepends it to the prompt; the README and the `t3-handoff` skill show the pattern.
Leaving it out keeps a thread free of cross-contamination.

### All commands go over the WebSocket

`POST /api/orchestration/dispatch` passes commands straight to the engine and ignores the `bootstrap` field, so a `thread.turn.start` with `bootstrap.createThread` fails with "thread does not exist".
Only the WebSocket `orchestration.dispatchCommand` runs the create-thread, worktree, and setup-script steps.
`T3Client.dispatch` always uses the WebSocket, so there is one dispatch path.
One socket per process is opened lazily and multiplexed by request id.
HTTP is left for snapshot reads, the WebSocket ticket, file upload bytes, and the unauthenticated environment descriptor.

### Waiting on a turn

`turn.ts` folds `orchestration.subscribeThread` items into a `TurnState` with a pure `step` function.
How it reads the opening snapshot depends on which turn is awaited:

- `current` (`wait`, `close`): the snapshot's turn. An idle thread settles immediately.
- `next` (`send --wait`): the snapshot is taken before dispatching, so its turn is an older one. Settles after a running state.
- `first` (`new --wait`): the thread is created by the dispatch, so the stream starts after it. The snapshot may show the turn running, settled, or not started yet (a pending turn start is not in the snapshot).

### Title seeding

Sending `titleSeed` makes the server regenerate the title after the first turn, even when `createThread.title` is set.
`new` sends `titleSeed` only when `--title` was not given.

## Server facts the design rests on

| Fact | Consequence |
| --- | --- |
| Commands are a tagged `ClientOrchestrationCommand` sent to WS `orchestration.dispatchCommand`. Reads are `GET /api/orchestration/shell` and `GET /api/orchestration/threads/:id`. | Most commands are one dispatch. |
| Dispatch returns only `{ sequence }`. Turn outcome arrives later as events. | `wait` and `watch` use the WebSocket stream `orchestration.subscribeThread`. |
| The WebSocket is Effect RPC over JSON: `{_tag:"Request", id, tag, payload, headers:[]}`. Streams are ack-gated: the server withholds the next `Chunk` until the client sends `{_tag:"Ack", requestId}`. | `T3Client.stream` acks every chunk. Without it a subscription stalls after the first batch. |
| Provider and model catalog is only on the wire as `ServerConfig.providers` via `server.getConfig` (WebSocket). Each model carries `capabilities.optionDescriptors`. | `providers` and `models` make one WebSocket call. `--option` values are validated against the descriptors. |
| `modelSelection` is `{ instanceId, model, options: [{id, value}] }`. Effort is a per-driver option id: `reasoningEffort` (codex, grok), `effort` (claudeAgent), `variant` (opencode). | `--option id=value` is the only spelling. `t3c models` prints the ids. |
| `thread.turn.start` accepts `bootstrap.createThread` and `bootstrap.prepareWorktree`. A failed worktree preparation sets an `error` session; other failures delete the thread. | `new` is one round trip. `new --wait` settles as `error` on either. |
| `subscribeThread` with `afterSequence` replays events. If the replayed range contains the thread's creation and the thread still exists, the server sends a fresh snapshot instead. | `new --wait` subscribes with `afterSequence: 0` after dispatching and handles both. |
| Bearer tokens live 30 days. No refresh grant. `t3 auth session issue --token-only` mints one from filesystem trust. A pairing token exchanges at `POST /oauth/token`. `POST /api/auth/websocket-ticket` gives a 5-minute ticket for `ws://…/ws?wsTicket=`. | Two login paths, one credentials file, the built-in `WebSocket` works without custom headers. |
| Running servers write `<T3 home>/{userdata,dev}/server-runtime.json` with `pid`, `port`, `origin`. `GET /.well-known/t3/environment` returns `environmentId`, `serverVersion`, `orchestrationProtocolVersion`, `capabilities`. | Local discovery needs no configuration. A failed WebSocket connect reports a protocol mismatch from the descriptor. |
| `/ws` takes `orchestrationProtocol=1`. Upstream `main` (after 0.0.45) moves to protocol 2: it rejects protocol 1 with `426`, removes HTTP dispatch, and replaces `thread.turn.start` with `message.dispatch` and `orchestration.launchThread`. | `t3c` speaks protocol 1 and needs a port before it can drive a protocol 2 server. |
| Turn end: `thread.session-set` with `session.activeTurnId === null` after a running state. `status` ends in `ready`, `idle`, `interrupted`, `stopped`, or `error`. Approval and question requests arrive as `thread.activity-appended` with `kind` `approval.requested` or `user-input.requested`, and clear with the matching `.resolved`. | Exit codes and the `needs-input` state derive from these. `src/turn.ts` holds the pure state machine. |
| Assistant text streams as `thread.message-sent` with `streaming: true` and cumulative text; the final `streaming: false` event carries empty text. | `watch` keeps the last streamed text per message and emits it on the final event. `wait` reads the final text from the detail snapshot. |
| Archived threads are absent from the shell snapshot; `orchestration.getArchivedShellSnapshot` lists them. | Thread lookup falls back to the archived snapshot, so `unarchive <title>` works. |
| Attachments: images go inline as `dataUrl`; other files need `attachments.createUploadUrl` then a `POST` of raw bytes with the file's mime type. The server enforces the limits (100 per message at 0.0.45). | `--attach` handles both. |

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
The WebSocket mints a ticket, connects to `/ws?wsTicket=…&clientSurface=cli&orchestrationProtocol=1`, sends one `Request` per call, acks each `Chunk`, and sends `Interrupt` when a call is abandoned.

## Commands and payloads

All ids are client-generated UUIDs.
`client.dispatch` stamps `commandId` and `createdAt` (the client clock; the server overwrites it).

### Discover

| Command | Call |
| --- | --- |
| `env` | `GET /.well-known/t3/environment` |
| `projects`, `threads [--project] [--archived]` | `GET /api/orchestration/shell`, or `orchestration.getArchivedShellSnapshot` |
| `providers`, `models [instance] [--all]` | WS `server.getConfig` |
| `search <query> [--limit]` | WS `orchestration.searchThreads { query, limit }` |
| `show <thread> [--turns] [--messages-only]` | `GET /api/orchestration/threads/:id?turnLimit=` |
| `pending <thread>` | same snapshot, filtered to unresolved approval and user-input activities |

### Drive

`new` sends one `thread.turn.start`:

```json
{
  "type": "thread.turn.start",
  "commandId": "<uuid>", "threadId": "<uuid>",
  "message": { "messageId": "<uuid>", "role": "user", "text": "<stdin>", "attachments": [] },
  "modelSelection": { "instanceId": "codex", "model": "gpt-6-astra", "options": [{ "id": "reasoningEffort", "value": "high" }] },
  "runtimeMode": "full-access", "interactionMode": "default",
  "titleSeed": "<first prompt line, only without --title>",
  "bootstrap": {
    "createThread": { "projectId", "title", "modelSelection", "runtimeMode", "interactionMode", "branch": null, "worktreePath": null, "createdAt" },
    "prepareWorktree": { "projectCwd": "<project workspaceRoot>", "baseBranch": "main", "branch": "nei/x", "startFromOrigin": true },
    "runSetupScript": true
  },
  "createdAt": "…"
}
```

`--no-prompt` sends a bare `thread.create` with the same `createThread` fields instead.

| Command | Payload |
| --- | --- |
| `send <thread> [--from-plan <planId>]` | `thread.turn.start` without `bootstrap`; `modelSelection` only when model flags were given; `sourceProposedPlan: { threadId, planId }` with `--from-plan` |
| `wait <thread> [--timeout]` | WS `orchestration.subscribeThread { threadId }`; exit 0 completed, 2 error, 3 interrupted or stopped, 4 needs input, 124 timeout |
| `watch <thread> [--raw] [--from <sequence>]` | same subscription, JSONL; `afterSequence` with `--from` |
| `interrupt <thread>` | `thread.turn.interrupt` |
| `approve <thread> <requestId> --decision <d>` | `thread.approval.respond { requestId, decision }` |
| `answer <thread> <requestId> --answer q=v…` | `thread.user-input.respond { requestId, answers }`; `--dismiss` sends `thread.user-input.dismiss` |
| `close <thread>` | `thread.turn.interrupt` if running, wait for the fence, then `thread.settle`. The one composite command, because settle is rejected during a turn. |

With `--wait`, `send` subscribes before dispatching so no event is missed; `new` replays from sequence 0 after dispatching (see "Waiting on a turn").

### Change

| Command | Payload |
| --- | --- |
| `set --title` / `--regenerate-title` / model flags / `--pull-request` | `thread.meta.update { title? , regenerateTitle?, modelSelection?, linkedPullRequest? }` |
| `set --runtime-mode` | `thread.runtime-mode.set { runtimeMode }` |
| `set --interaction-mode` | `thread.interaction-mode.set { interactionMode }` |
| `settle`, `archive`, `unarchive`, `pin`, `unpin`, `delete --yes` | the same-named command with only `threadId` |
| `unsettle`, `unsnooze` | `{ reason: "user" }` |
| `snooze --until <iso\|duration>` | `thread.snooze { snoozedUntil }` |
| `stop [--only-if-settled]` | `thread.session.stop` |
| `revert --turn-count <n>` | `thread.checkpoint.revert { turnCount }` |
| `diff [--from-turn-count] [--to-turn-count] [--full]` | WS `orchestration.getTurnDiff` or `orchestration.getFullThreadDiff` |
| `project-add`, `project-set`, `project-remove` | `project.create`, `project.meta.update`, `project.delete` |

## Code layout

```text
src/
  bin.ts          command table, help, exit codes
  cli.ts          parseArgs wrapper, flag helpers, enum lists checked against upstream unions, table output
  errors.ts       T3Error and UsageError with exit codes
  client.ts       T3Client: typed WebSocket RPC (call, stream, dispatch) and HTTP
  credentials.ts  credentials file, local discovery, pairing URL parsing
  model.ts        --option parsing, model selection, descriptor validation
  turn.ts         pure turn-outcome reducer, event summaries
  resolve.ts      thread and project lookup by id, prefix, title, or path
  attachments.ts  stdin prompt, inline images, file uploads
  commands/       one file per command group
scripts/contracts.sh  checks out upstream contracts for typecheck
test/
  *.test.ts       fixture-driven runners and unit tests
  fixtures/       <case>.input.json + <case>.expected.json
skills/t3-handoff/SKILL.md
```

The pure core is tested from fixtures without a server.
Live behavior was verified against a scratch server started with `t3 serve --base-dir <tmp> --port <port>`, including full `new --wait` and `send --wait` turns.

## Out of scope

- Parent/child links, badges, auto-settle on close. All need server changes; see t3code discussion #8433 and PR #2829.
- Terminal, preview, pull request, and git commands. The API exists; nothing in the handoff use case needs them.
- Local queueing, retry, or scheduling. Dispatch is idempotent by `commandId`; a plain retry of the same payload is safe.
