# Changelog

## 1.0.11

- The New agent button (and Ctrl+N) opens the full New agent page again. The small arrow next to it opens the quick menu.
- The New agent page has a Project picker: your saved projects, folders of running agents, "Add project..." and "Choose another folder...". It remembers the last project you used.
- The + on a project in the sidebar opens the New agent page with that project already chosen.

## 1.0.10

- New sidebar: your agents are grouped under projects. Add a project, start a "+ New agent" inside it, and fold a project away. Agent rows are slim, one line each. Group by project or by status, with Pinned on top.
- A "New agent" button (Ctrl+N) and a Search row now sit at the top of the sidebar.
- Agents waiting for you now show a "Needs you" label.
- You can hide agents you don't use from the New agent menu ("Edit list...").
- "Hand off from here" / Hand off button: the agent writes a HANDOFF.md, then a new agent of the same kind and model picks it up.

## 1.0.9

- Fix: after an install or update, Windows started Potato Workspace with a restriction that stops it following links, so agents installed through links (like Codex) failed with "No application is associated with the specified file". Potato Workspace now restarts itself without that restriction, and if it can't, tells you to reopen it from the Start menu.
- Fix: Codex in the Chat tab now gets Potato Workspace's tools (they were dropped when Codex's own settings had an entry with the same name).
- Fix: Codex started with "never ask" approvals can now use Potato Workspace's tools; only Potato Workspace's own server is pre-approved. "Add Potato Workspace to your agents" offers to add this to existing Codex settings, with Undo.

## 1.0.8

- Fix: agents in a Terminal pane failed to start with "No application is associated with the specified file" when the first matching program on PATH was a broken link (for example during a Codex self-update or after a winget upgrade). Potato Workspace now starts the first program that can actually run, by its full path, and says which files it tried if none can.
- Fix: the setup check now finds agents installed with winget, and winget's "already installed / no upgrade" answer counts as success instead of an error.

## 1.0.7

- Fix: chats in the installed app now get Potato Workspace's tools (the app looked for its tool program in the wrong folder). A chat says so if the tools can't be added. Same folder fix for phone pairing and agent adapters.
- Fix: "Add Potato Workspace to your agents" repairs the connection 1.0.6 wrote that pointed at a program that doesn't exist.
- Helper agents setting: Always show them (default), Let the agent choose, or Always run in the background. "Keep helpers open when they finish" is on by default.
- Stop is now the send button; the Working bar is gone.
- Pin chats to the top of the list.
- + menu: Add files, Add folder, Add image. Folders show as a chip with a file count.
- Set up any agent by choosing its settings file (and skills folder), including agents Potato Workspace doesn't know.

## 1.0.6

- New chat look: a decision card for permission asks (Allow or Deny, with "Don't ask again in this chat", hold to allow for deletes and moves, and answered asks fold to one line). Agent thinking is shown and folded. Tool calls show as cards with a status. Terminal output has Copy, change cards have Copy patch, and there is a live step list with a timer, plan progress, code block headers, and Copy and Retry under replies.
- New message box: one card with model and mode menus, an effort switch, a context ring and stacked queued messages.
- "Add Potato Workspace to your agents" now also sets up custom agents and store agents (Gemini CLI, Qwen Code, Copilot CLI, Droid, Auggie, Kimi Code, Kiro; Mistral Vibe gets skills only). It lists the agents it cannot set up, with the reason.

## 1.0.5

- Chat messages show added files as chips instead of pasting file text into the message. Paste images with Ctrl+V. Type @ to add a project file.
- Files reach the agent as real attachments: images as images when the agent supports them, other files as file links or file contents.
- Fixed: 1.0.4 did not bring over data from 1.0.3. On first start, 1.0.5 copies your 1.0.3 data once. It only fills in missing files and never changes the old folders.
- Fixed: Potato Workspace now uses its own ports (17421-17499) so it does not clash with Puppet Master.
- Security fixes for the local bridge, the proxy marker and checkpoint restore.

## 1.0.4

- Potato Workspace is fully separate from Puppet Master: its own tool server, skill pack, ports, data folders, companion folders and release uploads.
- Existing data in the old folders is copied once into Potato Workspace's own folders; the originals are left untouched.
- Chat helpers now apply the requested model and reasoning before the first message, and report the model actually in use instead of silently using another one.
- Helpers started from a chat are nested under the chat that started them, the same as terminal helpers.
- Fixed: a helper chat now keeps its starter and its parent pane across an app restart. The link is saved with the conversation, so a restored chat stays nested under its parent and its starter keeps owner-only control. Older saved conversations still load.
- Chat replies now report background work separately from the turn: `wait_agents` keeps waiting while reported background tasks run, and `background_tracking` says when an agent cannot report them.
- Every permission prompt now records why it ended (`answered_by_person`, `answered_by_agent`, `cancelled`, `turn_ended`, `session_ended`), and `wait_agents` can confirm that a prompt is stable with `confirm_prompt_ms`.
- `wait_agents` replies also include how long a prompt has been open and the last prompt that ended.
- Chat messages can now attach files: the + button (or dropping files on the message box) takes several at once, puts text and code file contents inline, and copies images, PDFs and other binary files into `.potato-workspace/attachments/` so both terminal and chat agents can open them.
- `wait_agents` now recognises a finished chat helper and returns its final reply once, instead of asking again with no pause. It also waits a short quiet window after reported background work drains so a later reply is not missed, paces retries when a wait slice returns early, and reports a local connection failure as `bridge_unreachable` (“the bridge may still be running”) instead of `bridge_down`.

## 1.0.3

- Helpers now show in the sidebar. Agents can no longer hide them unless you turn on Allow hidden helpers.
- The model and effort you ask for are now what the helper runs on.
- Read-only helpers work in a visible pane.
- Trust this folder now works on the screen that lists pre-approved tools.

## 1.0.2

- Agents installed while the app is open now work without restarting the app.
- Helpers can use a different login: choose it in Settings, or pick it on a card.

## 1.0.1

- Update test release: no changes to the app.

## 1.0.0

- First release of Potato Workspace: agents, panes, terminal and chat in one app.
- Installer includes Node.js, npm, Git and cloudflared.
- One-click updates from GitHub Releases.

## 0.1.5 - security patch

- Fixes a bridge authorization bypass: requests that came through a tunnel, a reverse proxy or a
  web page were trusted as the desktop app and needed no paired-device token. All earlier
  releases (0.1.0 to 0.1.4) are affected; update. Details and what to do:
  `docs/security/2026-10-14-tunnel-auth-bypass.md`.

## 0.1.2 — PWA fixes and MCP publishing

- Mobile PWA bug fixes and polish
- MCP server publishing workflow (`@puppet-master/mcp`)

## 0.1.0 — initial scaffold


- Monorepo: `@puppet-master/{shared,cli,bridge,mcp,app}` workspaces
- Tauri 2 + React + xterm.js desktop app
- Rust PTY manager with `portable-pty` (Windows ConPTY)
- 5 MCP tools: `list_panes`, `spawn_agent`, `read_terminal_buffer`, `write_terminal_input`, `kill_pane_process`
- Local HTTP bridge (Node stdlib) with SSE event stream
- Built-in Puppet Master LLM chat (Anthropic + OpenAI) using the same MCP tools
- Settings panel for API keys + model picker (Anthropic / OpenAI)
- Status heuristics: `running` / `waiting_input` / `idle` / `error`
- Unit tests: 6 scrollback buffer tests passing
- Bridge smoke test: `scripts/test-bridge.ps1`
- MCP smoke test: `scripts/test-mcp.ps1`
