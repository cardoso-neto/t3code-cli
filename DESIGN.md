# t3code-cli design

> 🤖 Fable 5.1 via Claude Code on behalf of Nei Cardoso

`t3c` is a thin TypeScript CLI that creates and drives T3 Code threads over the server's public API.
It is downstream of t3code: no server changes, no forks.

Verified against t3code `v0.0.41-nightly.20260909` source and a live `0.0.40` server on 2026-09-13.
Every command below was exercised against a scratch server with codex and claudeAgent.

## Principles

- Thin client. JSON in, JSON out. No second database, no agent runtime. The server validates every payload.
- One server operation per command, documented below, so agents can reason about side effects.
- Discover, do not hardcode. Providers, models, and option ids come from the running server.
- T3's own names. Flags mirror the wire fields (`--instance-id`, `--model`, `--option id=value`, `--runtime-mode`, `--interaction-mode`, `--prepare-worktree`). No aliases such as `--effort`.
- Same idiom as the codex and claude handoff skills: prompt on stdin, JSONL on stdout, a stable id to resume, exit code carries the outcome.
- Zero runtime dependencies. Node 22+ ships `fetch`, `WebSocket`, `parseArgs`, and `randomUUID`.

## Decisions

### Contracts are unpublished

`@t3tools/contracts` is `private: true`, exports TypeScript source, and is never published.
Options were:

1. Depend on the t3code git repo and build the contracts package ourselves. Pulls in Effect 4 beta and couples us to an internal package's churn.
2. Vendor the schema files. Same coupling, plus a copy to keep in sync.
3. Hand-type only the fields we send and read, with upstream file references, and let the server validate.

We chose 3. `src/contracts.ts` is about 200 lines.
Drift shows up as a `400` with the server's schema issue in the error message, which the CLI surfaces verbatim.
When t3code publishes a contracts package, swapping the types is mechanical.

### Lineage is prompt content, not a CLI feature

T3 stores no parent/child relationship between threads.
The CLI does not fake one.
When the child should know its origin, the caller prepends it to the prompt; the README and the `t3-handoff` skill show the pattern.
Leaving it out keeps a thread free of cross-contamination.

### Bootstrap turn-starts go over the WebSocket

`POST /api/orchestration/dispatch` passes commands straight to the engine and ignores the `bootstrap` field, so a `thread.turn.start` with `bootstrap.createThread` fails with "thread does not exist".
Only the WebSocket `orchestration.dispatchCommand` runs the create-thread, worktree, and setup-script steps.
`T3Client.dispatch` routes commands that carry `bootstrap` over the WebSocket and everything else over HTTP.

### Title seeding

Sending `titleSeed` makes the server regenerate the title after the first turn, even when `createThread.title` is set.
`new` sends `titleSeed` only when `--title` was not given.

## Server facts the design rests on

| Fact | Consequence |
| --- | --- |
| Commands go through one endpoint, `POST /api/orchestration/dispatch`, with a tagged `ClientOrchestrationCommand`. Reads are `GET /api/orchestration/shell` and `GET /api/orchestration/threads/:id`. | Most commands are a single HTTP call. |
| Dispatch returns only `{ sequence }`. Turn outcome arrives later as events. | `wait` and `watch` use the WebSocket stream `orchestration.subscribeThread`. |
| The WebSocket is Effect RPC over JSON: `{_tag:"Request", id, tag, payload, headers:[]}`. Streams are ack-gated: the server withholds the next `Chunk` until the client sends `{_tag:"Ack", requestId}`. | `T3Client.subscribe` acks every chunk. Without it a subscription stalls after the first batch. |
| Provider and model catalog is only on the wire as `ServerConfig.providers` via `server.getConfig` (WebSocket). Each model carries `capabilities.optionDescriptors`. | `providers` and `models` open one short WebSocket request. `--option` values are validated against the descriptors. |
| `modelSelection` is `{ instanceId, model, options: [{id, value}] }`. Effort is a per-driver option id: `reasoningEffort` (codex, grok), `effort` (claudeAgent), `variant` (opencode). | `--option id=value` is the only spelling. `t3c models` prints the ids. |
| `thread.turn.start` accepts `bootstrap.createThread` and `bootstrap.prepareWorktree`. On failure the thread is deleted. | `new` is one round trip. |
| Bearer tokens live 30 days. No refresh grant. `t3 auth session issue --token-only` mints one from filesystem trust. A pairing token exchanges at `POST /oauth/token`. `POST /api/auth/websocket-ticket` gives a 5-minute ticket for `ws://…/ws?wsTicket=`. | Two login paths, one credentials file, the built-in `WebSocket` works without custom headers. |
| Running servers write `<T3 home>/{userdata,dev}/server-runtime.json` with `pid`, `port`, `origin`. `GET /.well-known/t3/environment` returns `environmentId`, `serverVersion`, `capabilities`. | Local discovery needs no configuration. |
| Turn end: `thread.session-set` with `session.activeTurnId === null` after a running state. `status` ends in `ready`, `idle`, `interrupted`, `stopped`, or `error`. Approval and question requests arrive as `thread.activity-appended` with `kind` `approval.requested` or `user-input.requested`, and clear with the matching `.resolved`. | Exit codes and the `needs-input` state derive from these. `src/turn.ts` holds the pure state machine. |
| Assistant text streams as `thread.message-sent` with `streaming: true` and cumulative text; the final `streaming: false` event carries empty text. | `watch` keeps the last streamed text per message and emits it on the final event. `wait` reads the final text from the detail snapshot. |
| Archived threads are absent from the shell snapshot; `orchestration.getArchivedShellSnapshot` lists them. | Thread lookup falls back to the archived snapshot, so `unarchive <title>` works. |
| Attachments: images go inline as `dataUrl`; other files need `attachments.createUploadUrl` then a `POST` of raw bytes with the file's mime type. Max 8 per message. | `--attach` handles both. |

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
| `t3c login --local [--base-dir] [--ttl] [--t3-bin]` | discover via `server-runtime.json`, then `t3 auth session issue --token-only --label … --base-dir …`; strips `T3_SERVICE_LAUNCHER_CONTEXT` from the child env so it works from inside a t3code-managed shell |
| `t3c login <pairing-url>` | `POST /oauth/token` with `grant_type=…token-exchange`, `subject_token`, `subject_token_type=urn:t3:params:oauth:token-type:environment-bootstrap`, `client_device_type=bot` |
| `t3c login --token <bearer> --origin <url>` | store a token minted elsewhere |
| `t3c envs` | list stored environments |

HTTP requests send `Authorization: Bearer`.
WebSocket connections mint a ticket, connect to `/ws?wsTicket=…&clientSurface=cli`, send one `Request`, ack each `Chunk`, and `Interrupt` on abort.

## Commands and payloads

All ids are client-generated UUIDs.
`createdAt` is the client clock; the server overwrites it.

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

With `--wait`, `new` and `send` subscribe before dispatching so no event is missed.

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
  cli.ts          parseArgs wrapper, flag helpers, table output
  client.ts       T3Client: HTTP, WebSocket request and ack-gated subscribe
  credentials.ts  credentials file, local discovery, pairing URL parsing
  contracts.ts    hand-typed wire shapes with upstream references
  payloads.ts     pure command builders
  model.ts        --option parsing, model selection, descriptor validation
  turn.ts         pure turn-outcome state machine, event summaries
  resolve.ts      thread and project lookup by id, prefix, title, or path
  attachments.ts  stdin prompt, inline images, file uploads
  commands/       one file per command group
test/
  *.test.ts       fixture-driven runners
  fixtures/       <case>.input.json + <case>.expected.json
skills/t3-handoff/SKILL.md
```

Pure builders and the turn state machine are tested from fixtures without a server.
Live behavior was verified against a scratch t3 server started with `t3 serve --base-dir .t3 --port 3899 --no-browser`.

## Out of scope

- Parent/child links, badges, auto-settle on close. All need server changes; see t3code discussion #8433 and PR #2829.
- Terminal, preview, pull request, and git commands. The API exists; nothing in the handoff use case needs them.
- Local queueing, retry, or scheduling. Dispatch is idempotent by `commandId`; a plain retry of the same payload is safe.
