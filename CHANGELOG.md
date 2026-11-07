# Changelog

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

## 1.0.4

- New setting **Allow hidden helpers** (Settings > Agents, off by default). While it is off, an agent that asks for a hidden
  helper (`headless: true`) gets a visible pane instead, and the result says the request was ignored. A helper that does
  run hidden is listed in the Inbox ("Claude helper ran with no window"), with its task and how it ended.

- A helper started with a model, a reasoning effort or read-only now really gets them: the asked model and effort go on the
  agent's own command line (hidden and in a pane) instead of the agent's settings file winning, and a read-only helper can
  be a visible pane for agents that can start one read-only. The receipt shows the model that actually ran and says plainly
  when it is not the one asked for, or when the agent cannot be told a model.

- Potato Bot sandbox OSes: Linux Mint (Cinnamon) joins Ubuntu, the Zorin look and the light desktop in the setup wizard. The
  Sandbox row now lists the OSes installed in the sandbox, switches the active one in one click, and has **Add OS…** to install
  another later without losing the sandbox's files. Mint and Zorin are desktops on the shared Ubuntu base, not separate distros.

- Pick for me: the first row of the "+" menu suggests one agent (and its saved login) for the project, from your own
  Scores for that project (last 90 days), and says why in one plain sentence. With little history it says it is too
  early and suggests your usual agent. Nothing starts until you press Start; nothing you type is read or sent, and
  nothing is stored. Desktop app only. Built and unit-tested; no live run with real agents yet. See
  `docs/features/pick-for-me.md`.

- Agent Store (preview, Windows only): a "More agents" grid of 19 terminal agents, opened from the "+" menu, Set up agents,
  Settings > Agents or the palette. Each card shows the vendor, the license, how to sign in and a tier: "Tested" (Kilo Code
  has captures from a Windows run) or "Basic support" (runs in a pane; not tested on Windows yet). Install shows the vendor's own
  command and runs it in a visible window after you confirm. Add, Check it works, Remove and Uninstall the program are separate
  steps, each with its own confirm. Sign in happens in the agent's own pane. Not run live yet; Amp, Grok CLI, Codebuff and
  Antigravity are not in the list. See `docs/features/agent-store.md`.

- Night Shift (Preview, off by default: Settings > General > Labs): write up to 10 tasks in Tonight, pick the plans and a stop
  time, and Puppet Master works through them while you sleep, each in its own separate copy, checking your declared tests
  after every turn. It never answers a trust, permission or sign-in screen, never merges anything, and sends one push in the
  morning with counts only. The Morning page shows what each task did; Keep merges a copy, Throw away deletes it. Tested end to
  end with fake agents (green tasks, a usage limit that moves to the other plan, a trust screen left alone, a stop time that cuts
  a task off, Keep, Throw away and a conflict); no live night with real agents yet. See `docs/features/night-shift.md`.

- Bring my old chats: an opt-in way to add the chats you had in Claude Code, Codex, OpenCode and any agent with a
  `[session_chat.history]` table to Ctrl+Shift+F search. Nothing is read until you press "Find my chats"; the chats stay on
  this PC, are redacted before they are saved, and "Remove imported chats" deletes them. Phone search can still show them
  (known gap, see `docs/features/bring-all-my-chats.md`).

- The Approve dialog for your own agents now shows the whole command: the program that will run (its path, with
  your user folder shown as `~`) and then the arguments, for the headless command and the visible pane command.
  A program that is not installed shows its name and "not found on this PC". The Agent Wizard's review screen
  shows the program path too. Nothing about approvals changed: a different program behind the same name was
  already caught by the pinned program path ("Changed since you approved it").
- Agent Wizard ("Finish without me"): a permission question that sits under the list of tool calls an agent
  printed (`Edited 1 file`, `Explored 1 file`) is read from its real options again, so the wizard answers it
  with the one-time yes instead of stopping. When a question really is yours to answer, the agent's pane now
  stays open: "Show the pane" opens it and Retry goes on from there (before, the stop closed the pane and
  the message told you to answer in a pane that was gone). If the agent quit by itself the message says so.
- Agent updates are now visible. When Claude Code, Codex, Cursor or OpenCode update, Settings > Agents and the Inbox say how it went
  ("Claude Code 2.3.0 to 2.4.0: checked, all good." or "...: screens changed. Puppet Master will ask you before acting."). A check that
  passes on this computer clears the "Untested version" label for that exact version only; the next update starts again. A run that
  cannot find an agent's input box, a screen Puppet Master cannot read, or a turn that goes quiet without saying it finished now starts
  one check (at most one per agent and version, never faster than every 10 minutes, and only while "Check agents after they update" is
  on). Before a run starts, a changed program file makes Puppet Master read the version right away instead of waiting up to 15 minutes.
- Windows: no more console windows flashing on screen while an agent runs. Starting the Cursor agent
  (whose launcher is PowerShell) or stopping a run used to open and close a PowerShell/`taskkill`
  window each time. Every helper process now starts hidden through one place (`proc_util`), a test
  fails if new code starts one any other way, and checking whether an MCP connection is still alive
  no longer starts `tasklist` at all.
- The "+" menu starts an agent in the folder you selected. **Separate copy** now starts off (it used to start
  on for a Git project); turn it on per agent, and your own choice for a project is still remembered.
  "+" starts in the last folder you used, Recent projects never list a separate copy, and the pane header
  says "separate copy of <folder>" when it is one.

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
