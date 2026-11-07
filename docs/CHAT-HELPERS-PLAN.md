# Plan: make chat helpers behave like helpers

**Status:** plan only. Nothing has been built or changed.
**Repo:** `potato-workspace`, at `25664b5` ("Version 1.0.2") plus the uncommitted working tree, checked 2026-11-07
**Paths:** under `packages/app/` unless they start elsewhere

## The problem

A chat agent was asked to start a non-headless helper on Haiku 5.5 at low reasoning. Three things went wrong.

| What you see | What actually happens |
|---|---|
| Claude 2's header says Sonnet 5.5 | The helper really ran on `claude-sonnet-5-5`. The requested model was dropped |
| Claude 2 is a top-level row in the sidebar | It should be indented under Claude 1, with the "N helpers" chip |
| Claude 1 said the helper was on Haiku and its pane would close | The reply never named a model, and it said `"pane_open": true`, so Claude 1 was assuming both |

**Evidence for the model:** Claude 1 called `run_agent` with `"model": "claude-haiku-5-5", "reasoning": "low", "headless": false`. Every reply in the helper's session log came from `claude-sonnet-5-5`, and the tool's reply had an empty `warnings` list.

## The cause

All of it comes down to one function. Your saved setting sends Claude agents through chat (`"claude": "acp"`), and `run()` in `src-tauri/src/acp/chat/surface.rs:331` handles those runs. It skips things the terminal path handles.

**Model and reasoning**
- `run()` doesn't pass on `model`, `reasoning` or `keep_pane`.
- `StartRequest` (`src-tauri/src/acp/chat/start.rs:29`) only has the agent, the folder and an `explicit` flag.
- The chat path can change settings through `set_config` (`src-tauri/src/acp/chat/mod.rs:815`), but `run()` never uses it.
- The reply built by `view()` (`surface.rs:158`) has no model field, so an agent can't tell that its request was dropped.

**Helper nesting**
- The UI already works. `src/components/cockpit/Sidebar.tsx` and `src/lib/pane-helpers.ts` nest any pane that has a `parent_pane_id`.
- Terminal helpers get the link: `src-tauri/src/bridge/dispatch.rs:384` calls `note_pane_parent`.
- Chat panes start with `parent_pane_id: None` (`src-tauri/src/pty/registry/virtual_pane.rs:124`), and `run()` never sets it. It only records `set_started_by(session)` (`surface.rs:372`), which the sidebar doesn't read.

**Finding the parent is the harder part** (from reading the code, not tested)
- The app finds the parent from the process that made the call, or from a pane ID passed to the tool program.
- Chat agents have no terminal process behind their pane, so the process check probably can't place them.
- Their tool config (`default_mcp_servers`, `src-tauri/src/acp/config.rs:815`) passes only the port file, not a pane ID.

## The plan

Make one change to `run()` that covers all of this, on a branch.

### 1. Apply model and reasoning before the first message

- Add `model` and `reasoning` to the chat start path, and apply them with `set_config` after the session opens and **before** the task is sent.
- First check the option IDs and values the Claude and Codex adapters offer, since they may not match `claude-haiku-5-5` or `low` exactly.
- Apply the same handling to follow-up messages (`followup` in `surface.rs`).

### 2. Never fall back silently

If the agent doesn't offer the requested model or effort, return a clear error or warning. Never quietly run on a different model.

A saved chat setting that was not an explicit `lane: "acp"` request could fall back to the terminal path instead, which already handles a requested model.

### 3. Report what actually ran

- Add the model and reasoning in use to the tool's reply, along with `warnings` when something differs from the request.
- Agents can then state them accurately instead of repeating what they asked for.

### 4. Tell each chat agent which pane it is

- Add the pane ID to the tool config for each chat session, the way terminal panes already do (`mcp_sessions::PANE_ID_ENV`).
- First check whether one adapter process serves several chats, because that decides how far the app can trust the ID.

### 5. Record the parent when a helper starts

- In the chat `run()`, work out the calling pane and call the same `set_parent` the terminal path uses.
- Do this before the task is sent, so the helper is nested from its first moment.
- The link stays display-only and gives no extra permissions, matching how it works today.

### 6. Cover every combination

| Parent | Helper |
|---|---|
| Chat | Chat (the reported case) |
| Chat | Terminal |
| Terminal | Chat |
| Terminal | Terminal (already works) |

A helper started by a helper should nest two levels deep.

### 7. Handle `keep_pane`

Apply the choice from decision 1 below, and put `pane_open` and what will happen to the pane in the reply, so agents stop guessing.

### 8. Check what comes with the link

These read `parent_pane_id`, so they should start working without new UI. Each one still needs checking:
- The indent and the "N helpers" chip in the sidebar
- The "helper of Claude 1" link at the top of the helper's pane
- The compact "Helper: …" row inside the parent's chat (`src/lib/chat-helpers.ts`)
- The Go Live share list (`src/components/cockpit/live/sharePanes.ts`)

## Testing

**Automated**
- A chat `run()` with a model and reasoning applies them before the first message.
- An option the agent doesn't offer gives a clear error or warning.
- The reply reports the model in use.
- `run()` from a chat records the parent.
- A call from outside any pane stays top-level.

**By hand in the app**

Repeat your exact prompt: "use potato workspace mcp to create a non headless subagent helper to do a simple task use haiku 5.5 low". Then check:
- Claude 2's header says Haiku 5.5.
- The helper's session log shows `claude-haiku-5-5`.
- Claude 2 is indented under Claude 1.
- Claude 1's message states what the reply says.
- The same works with a Codex helper and a terminal helper.

The effort level can't be confirmed from the logs that were checked, so testing it needs another source, such as the session's reported config options.

Run on Mac and on Windows. Windows needs a real PC.

## Decisions for the owner

The defaults below are recommendations. The owner has not confirmed them.

1. **When a chat helper finishes:** default is that it stays nested under its parent until you close it, or until the parent closes. You can still read its result, and it doesn't clutter the top level. The alternative is to close it automatically unless `keep_pane` is set, like terminal helpers.
2. **A model the agent doesn't offer:** default is an error for an explicit `lane: "acp"` request, and falling back to the terminal path with a warning when chat only came from the saved setting.

## Limits

- Claude 2 and other existing helpers stay top-level, because the link is only recorded when a helper starts. Only new helpers will nest.
- This plan doesn't cover the wider Puppet Master separation. See `SEPARATE-FROM-PUPPET-MASTER.md`.
