# Changelog

## Unreleased

- Potato Workspace is fully separate from Puppet Master: its own tool server, skill pack, ports, data folders, companion folders and release uploads.
- Existing data in the old folders is copied once into Potato Workspace's own folders; the originals are left untouched.
- Chat helpers now apply the requested model and reasoning before the first message, and report the model actually in use instead of silently using another one.
- Helpers started from a chat are nested under the chat that started them, the same as terminal helpers.
- Chat replies now report background work separately from the turn: `wait_agents` keeps waiting while reported background tasks run, and `background_tracking` says when an agent cannot report them.
- Every permission prompt now records why it ended (`answered_by_person`, `answered_by_agent`, `cancelled`, `turn_ended`, `session_ended`), and `wait_agents` can confirm that a prompt is stable with `confirm_prompt_ms`.
- `wait_agents` replies also include how long a prompt has been open and the last prompt that ended.
- Chat messages can now attach files: the + button (or dropping files on the message box) takes several at once, puts text and code file contents inline, and copies images, PDFs and other binary files into `.potato-workspace/attachments/` so both terminal and chat agents can open them.
- `wait_agents` now recognises a finished chat helper and returns its final reply once, instead of asking again with no pause. It also waits a short quiet window after reported background work drains so a later reply is not missed, paces retries when a wait slice returns early, and reports a local connection failure as `bridge_unreachable` (“the bridge may still be running”) instead of `bridge_down`.

### Field feedback from a delegated Haiku 5.5 run

> “The MCP works, but it was rougher than it should have been.”
>
> **What worked well**
> - `run_agent`, `wait_agents` and `followup_task` fit together simply. I got a handle back and could continue the same conversation on it.
> - The visible run correctly picked Haiku 5.5 at low reasoning. It also reported model mismatches, which is how I caught that the headless run had actually used Sonnet.
> - The receipts and the `not_verified` list are honest about what wasn't checked, and I like that.
>
> **Friction**
> - **Silent model swap:** I asked for Haiku and the headless run came back as `resolved_model: claude-sonnet-5-5`. It did say `model_mismatch: true` and `model_verified: false`, but only at the end, in the wait result. If I hadn't read that carefully, I'd have believed I got Haiku.
> - **Headless runs are hard to steer:** I wanted to switch to a visible pane partway through. The only option was to start a second run, and I didn't cancel the first. A “restart this run visibly” option would help.
> - **Version-mismatch warning:** The `SCHEMA_DRIFT` warning is attached to every response and is very long. It adds a lot of noise to each reply.
> - **Mixed handle formats:** One run gave me a UUID and the other gave an `acp-…` pane id. The handles looked different and behaved a bit differently, for example in whether a pane stays open.
> - **Deferred tool schemas:** I had to load them with `ToolSearch` before I could call anything. That's the harness, not the MCP.
> - **Blocked sleep:** The `sleep 60` block came from the subagent's harness, not the MCP. The agent handled it well by refusing to work around it and asking.
>
> **Overall:** It's a solid delegation layer, and I'd use it again. The main fix I'd want is a loud, up-front error or confirmation when the requested model can't be honored, instead of a flag you find later.

## 1.0.2

- Agents installed while the app is open now work without restarting the app.
- Helpers can use a different login: choose it in Settings, or pick it on a card.

## 1.0.1

- Update test release: no changes to the app.

## 1.0.0

- First release of Potato Workspace: agents, panes, terminal and chat in one app.
- Installer includes Node.js, npm, Git and cloudflared.
- One-click updates from GitHub Releases.
