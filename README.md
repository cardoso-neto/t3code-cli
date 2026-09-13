# t3code-cli

`t3c` creates and drives [T3 Code](https://github.com/pingdotgg/t3code) threads from the command line.
Pick the provider instance, model, provider options, runtime mode, interaction mode, and workspace.
Then send prompts, wait for replies, watch events, and manage the thread's lifecycle.

It talks to a running T3 Code server over its public HTTP and WebSocket API.
No server changes, no second database, no runtime dependencies.

## Install

Node 22.16 or newer.

```sh
git clone https://github.com/cardoso-neto/t3code-cli
cd t3code-cli
npm install
npm run build
npm link            # puts `t3c` on PATH
```

## Connect

Same machine as the server:

```sh
t3c login --local --default
```

This finds the server through `server-runtime.json` in the T3 home and mints a 30-day token with `t3 auth session issue`.
It needs the `t3` binary on PATH, or `--t3-bin <path>`.

Remote server:

```sh
t3c login 'http://host:3773/pair#token=ABCD2345EFGH'
```

Get a pairing URL from the server's Settings, `t3 pair`, or `t3 auth pairing create`.
Pairing tokens are single use and expire in five minutes.

Credentials live in `~/.config/t3code-cli/credentials.json`.
Use `--env <id|label|origin>` or `T3C_ENV` to pick between several stored environments.
Every command accepts `--json`.

## Create a thread

```sh
t3c projects
t3c providers
t3c models codex

t3c new --project t3code \
  --instance-id codex --model gpt-6-astra --option reasoningEffort=high \
  --wait < brief.md
```

Flag names are T3's own field names.

| Flag | T3 field |
| --- | --- |
| `--instance-id` | `modelSelection.instanceId` (`codex`, `claudeAgent`, `cursor`, `grok`, `opencode`, `antigravity`, or a custom instance) |
| `--model` | `modelSelection.model` |
| `--option id=value` | one entry in `modelSelection.options`; ids and values come from `t3c models` |
| `--runtime-mode` | `runtimeMode`: `approval-required`, `auto-accept-edits`, `auto`, `full-access` |
| `--interaction-mode` | `interactionMode`: `default`, `plan` |
| `--prepare-worktree --base-branch --branch --start-from-origin` | `bootstrap.prepareWorktree` |
| `--run-setup-script` | `bootstrap.runSetupScript` |

Options are validated against the model's descriptors before sending.
`--no-validate` skips that.
Without `--instance-id` and `--model`, the project's default model applies, then the server's default.

The prompt comes from stdin or `--prompt-file`.
`--attach <path>` adds images inline and uploads other files.

## Drive it

```sh
t3c send <thread> --wait < followup.md
t3c wait <thread> --timeout 2h
t3c watch <thread>            # JSONL event stream
t3c show <thread>
t3c pending <thread>
t3c approve <thread> <requestId> --decision accept
t3c answer <thread> <requestId> --answer q1=yes
t3c interrupt <thread>
t3c close <thread>            # interrupt if running, then settle
```

`wait` exit codes: 0 completed, 2 error, 3 interrupted, 4 waiting on approval or input, 124 timeout.
A timeout never cancels the turn.

Threads are addressed by id, unique id prefix, or exact title.
Projects also accept a workspace path.

## Change and manage

```sh
t3c set <thread> --title "New title"
t3c set <thread> --instance-id claudeAgent --model claude-fable-5-1 --option effort=max
t3c set <thread> --runtime-mode approval-required --interaction-mode plan
t3c settle | unsettle | archive | unarchive | snooze --until 3h | unsnooze | pin | unpin
t3c stop <thread>
t3c revert <thread> --turn-count 2
t3c diff <thread> [--full]
t3c delete <thread> --yes
t3c project-add <path> | project-set <project> ... | project-remove <project>
```

## Handoffs between agents

An agent can open a T3 thread for another agent and wait for the result:

```sh
id=$(t3c new --project . --instance-id claudeAgent --model claude-fable-5-1 \
       --option effort=high --title "Review: reconnect path" --json < brief.md | jq -r .threadId)
t3c wait "$id" --timeout 2h --json > result.json
```

T3 has no parent/child link between threads, and this CLI does not add one.
If the child should know where it came from, say so in the prompt:

```sh
{
  echo "Context: this thread was opened by T3 thread 4f20e2b5 (Programmatic Thread Creation)."
  echo "Reply here when done; the parent will read this thread."
  cat brief.md
} | t3c new --project . --instance-id codex --model gpt-6-astra --wait
```

Leave that out when the child must start clean.

## How it maps to the server

Almost every command is one `POST /api/orchestration/dispatch` with a `ClientOrchestrationCommand`.
Reads use `GET /api/orchestration/shell` and `GET /api/orchestration/threads/:id`.
Provider and model discovery, search, diffs, and the event stream use the WebSocket RPC.
A `thread.turn.start` with a `bootstrap` also goes over the WebSocket, because only that route runs the create-thread and worktree steps.

See [DESIGN.md](DESIGN.md) for the command-to-payload table and the upstream contract references.

## Development

```sh
npm run typecheck
npm test                      # fixture-driven, no server needed
npm run t3c -- --help         # run from source
```

Wire shapes are hand-typed in `src/contracts.ts` because `@t3tools/contracts` is a private package.
The server validates every payload, so a drift shows up as a `400` with the schema issue.
