# t3code-cli

`t3c` creates and drives [T3 Code](https://github.com/pingdotgg/t3code) threads from the command line, over the server's public API.
No server changes, no runtime dependencies.

```sh
npm install && npm run build && npm link

t3c login --local                  # same machine; or: t3c login '<pairing-url>'
t3c models codex                   # instance ids, model slugs, option ids

t3c new --project . \
  --instance-id codex --model gpt-6-astra --option reasoningEffort=high \
  --wait < brief.md

t3c send <thread> --wait < followup.md
t3c watch <thread>                 # JSONL event stream
t3c close <thread>                 # interrupt if running, then settle
```

Flags mirror T3's field names: `--instance-id`, `--model`, `--option id=value`, `--runtime-mode`, `--interaction-mode`, `--prepare-worktree`.
Prompts come from stdin.
Every command takes `--json`.
`t3c --help` lists the rest.

`wait` exits 0 on completion, 2 on error, 3 if interrupted, 4 when the thread needs an approval or answer, 124 on timeout.

[DESIGN.md](DESIGN.md) maps each command to the payload it sends.
`skills/t3-handoff` teaches an agent to delegate work through `t3c`.
