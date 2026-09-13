---
name: t3-handoff
description: Delegate work to another agent as a visible T3 Code thread with `t3c`. Use when a task should run in its own T3 thread so a human can inspect, steer, or take it over.
---

# T3 handoff

Open a T3 thread with a chosen provider and model, pass a complete brief on stdin, and wait for the result.

```sh
set -o pipefail
id=$(t3c new --project "$workspace" \
  --instance-id codex --model gpt-6-astra --option reasoningEffort=high \
  --title "$title" --json < "$brief" | jq -r .threadId)
t3c watch "$id" > "$events" &
t3c wait "$id" --timeout 2h --json > "$result"
```

- `$result` holds `state`, `turnId`, `text` (the final reply), and `lastError`.
- Exit codes: 0 completed, 2 error, 3 interrupted, 4 waiting on approval or input, 124 timeout.
  - On 4, run `t3c pending "$id"` and answer with `t3c approve` or `t3c answer`.
  - A timeout never cancels the turn; `t3c wait "$id"` again to keep waiting.
- Follow up with `t3c send "$id" --wait < more.md`.
- Pick providers, models, and option ids from `t3c providers` and `t3c models`; the installed server is authoritative.
- Add `--prepare-worktree --branch <name>` when the child edits files and the parent keeps working in the same checkout.
- Use `--runtime-mode approval-required` when a human should approve commands; then poll with `t3c pending`.

## Context

T3 stores no link between threads.
Put the origin in the brief when the child should know it, and leave it out when the child must start clean:

```sh
{ echo "Context: opened by T3 thread $PARENT_THREAD_ID. Reply here; the parent reads this thread."; cat "$brief"; } \
  | t3c new --project "$workspace" --instance-id claudeAgent --model claude-fable-5-1 --option effort=high --wait
```

## Cleanup

- `t3c close "$id"` interrupts if needed and settles the thread; it stays readable and `t3c send` reopens it.
- `t3c archive "$id"` hides it from the active list.
