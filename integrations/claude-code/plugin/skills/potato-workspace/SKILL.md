---
name: potato-workspace
description: Delegate work to other AI coding agents (Claude Code, Codex, Cursor, OpenCode) through the Potato Workspace MCP tools. Use it for a second opinion or review from a different agent, a quick question to another model, a parallel or risky change in an isolated git worktree, or to check on agents that are already running. Needs the Potato Workspace desktop app to be running.
---
<!-- potato-workspace-pack: 1 -->

# Delegating with Potato Workspace

Potato Workspace lets you hand work to other coding agents and get back a result plus a receipt that says what was and was not verified. Your host may show its tools with a prefix (for example `mcp__potato-workspace__run_agent`). If they are missing, the Potato Workspace app is not running: tell the user, do not guess.

## When to use it

- A **second opinion** from a different agent before you call work done.
- A **tiny question** you want answered by another model.
- A **parallel** or **risky** change that should not touch the user's files yet.
- **Checking on** agents that are already running.

Do not delegate what you can do directly in a few steps, and never put secrets in a task.

## The five tools

1. **`quick_ask(task)`** for a tiny question. Read `answer`. `receipt.not_verified` lists what was not checked. If it returns `status: "running"`, call `wait_agents` with the `handle`.
2. **`run_agent(agent_type, project_path, task)`** for real work. `agent_type` is `claude`, `codex`, `cursor_agent` or `opencode_native`. It opens a visible pane the user can watch and keeps it open when the run ends (the user decides in Settings whether helpers are shown, run in the background, or stay open; do not pass `headless`), runs the task and returns `status`, `result`, `receipt` and a `handle`. Pick a different agent than yourself for a review.
3. **`wait_agents(handles)`** collects results. Each call waits at most 120 s, so loop while `status` is `running`. A turn that still runs carries a `watch_command`: run it in your shell tool's background mode.
   - `completed` can mean only that the turn ended. Check `background_running` and `background_tracking`. When the adapter reports background work, `wait_agents` keeps waiting by default; pass `wait_for_background: false` only if you really want the turn-only answer.
   - When `background_tracking` is `not_reported_by_adapter`, the app cannot see work that outlives the turn: say so instead of claiming the agent is done.
   - If `wait_agents` itself fails with `bridge_unreachable`, the app may still be running: it was a local connection problem, not proof the agent is gone. Retry, and read the helper's transcript (`agent_transcript`) or its pane before saying you got no reply.
4. **`followup_task(handle, task)`** is the next turn with the same agent and the same conversation. `send_message(handle, message)` steers the turn that is running now.
5. **`list_agents()`** shows agents you can reuse: pass the `worker_id` to `run_agent` to adopt one.

## Do not trust "done"

Read `receipt.outcome`. Only `passed_checks` means the result was proven. `completed_unchecked` means the agent finished and nothing verified it.

Pass `checks` to `run_agent` so success is measured, for example:

```json
{ "checks": [
  { "type": "command_exits", "command": ["npm", "test"] },
  { "type": "file_exists", "path": "src/new-file.ts" }
] }
```

Other check types: `file_contains` (with `text`), `file_absent`, `result_contains`. A failed check ends the run as `ACCEPTANCE_FAILED`. When you report back, say what the receipt did not verify.

## Isolate risky or parallel edits

Pass `isolation: "worktree"` to `run_agent`. The agent works on its own branch `pm/<handle>` under `.potato-workspace/worktrees`, so parallel agents never touch the same files. The receipt gains `worktree` with the change counts. Nothing is merged for you:

- `review_worktree(handle)` shows the diff.
- `review_worktree(handle, action: "merge")` merges it. `action: "discard"` deletes the work.

Merge or discard only when the user has said so.

## Ask the human

- `ask_user(question, choices?)` when only the person can decide. It shows in the Potato Workspace Inbox and on a paired phone, and blocks until answered. Do not ask what you can find out yourself.
- If a run ends `needs_input`, it carries a `prompt`. One `waiting_input` reading is not proof that the agent is blocked: call `wait_agents` with `confirm_prompt_ms: 3000` and check that the same `prompt_id` is still open. Then show it to the user with `ask_user`, and pass their choice to `answer_prompt(handle, prompt_id, choice)`. Never choose approvals for them.
- `prompt.open_ms` says how long the prompt has been open. `last_prompt.reason` (`answered_by_person`, `answered_by_agent`, `cancelled`, `turn_ended`, `session_ended`) says why an earlier prompt went away.

- A `bridge_unreachable` error from any tool means this side could not open a connection to the running app. The app may be fine and the helper may have replied. Retry once, then read `agent_transcript` or the pane before reporting failure.

## Etiquette

- Use `read_only: true` for reviews and questions.
- `interrupt_agent(handle)` stops a turn and keeps the handle.
- Do not close the user's own panes. Panes a run created close themselves; pass `keep_pane: true` to keep one.
- Reuse the same `idempotency_key` when you retry after a timeout, so no duplicate turn starts.
