# Troubleshooting

## The MCP server cannot reach the app

Symptom: tools fail immediately with `BRIDGE_UNAVAILABLE`, `bridge_down`, or `fetch failed`.

Puppet Master is a desktop app with an embedded bridge. The MCP package is a stateless shim; it does **not** start a daemon.

1. Start the desktop app and leave it running (the tray icon is enough).
2. Check the bridge: `http://127.0.0.1:17321/health` should return `{"ok":true,...}`. The actual port may be higher; the app scans `17321–17399`.
3. Find the port file:
   - Windows: `%APPDATA%\com.puppetmaster.app\puppet-master.bridge.port`
   - macOS: `~/Library/Application Support/com.puppetmaster.app/puppet-master.bridge.port`
   - Linux: `~/.local/share/com.puppetmaster.app/puppet-master.bridge.port`
4. If you use a named profile, point the host at the profile's port file with `PUPPET_MASTER_BRIDGE_PORT_FILE`, or unset the profile.
5. A reverse proxy, CDN, or non-loopback `Host` header makes the bridge treat the caller as remote. Remote callers need a paired-device token; only the static PWA and pairing routes are public.

The app writes a per-launch secret next to the port file (`puppet-master.bridge.secret`). The shim sends it as `X-PM-Local-Secret`. If the app restarted, restart the MCP server so it re-reads the file.

## The host shows the wrong tools or a stale catalog

- Each connection starts in **agent mode** and sees agent tools only. Call `set_mode({ "mode": "shell" })` or `"both"` for PTY tools. `mode: "all"` also lists aliases and advanced tools.
- Hosts that cache `tools/list` ignore `notifications/tools/list_changed`. Restart the MCP server after `set_mode`.
- If `tool_count` in `GET /health` differs from what the host shows, the host has a cached list. Reconnect it.
- `SCHEMA_DRIFT` means the MCP binary and the running app were built from different tool catalogs. Rebuild with `npm run build:mcp`, then restart the host. If the app is older, update the app instead.

## `Puppet Master bridge port file not found`

The shim looked in the current directory and the OS app-data folder and found neither.

- Start the app once.
- Or set `PUPPET_MASTER_BRIDGE_PORT_FILE` to the file's full path (supports `%APPDATA%`).
- A stale file is harmless: the shim probes the port and reports `BRIDGE_UNAVAILABLE` if nothing answers.

## A run returns `WAIT_TIMEOUT`

That is normal for long turns, not an error.

- The response includes a `watch_command`; run it in the background and keep working.
- Or call `wait_agents` again with the same handles. Each call caps at 300 seconds.
- If you retry the original request, reuse the same `idempotency_key` so you adopt the existing run instead of starting a second one.
- Call `inspect_agent(handle)` to see stage, revision, and whether the pane is open.

## `UNKNOWN_AGENT_TYPE`

The backend id is not registered on this machine. `context.valid` lists the accepted ids.

- `GET /agents/types` shows what is registered and whether headless is supported.
- Install the agent (Settings > Agents or the Agent Store) or add a custom definition.
- Ids must match `^[a-z][a-z0-9_]{1,31}$`.

## A visible run failed or fell back to headless

Expected fallbacks are recorded in `receipt.fallback` and on the run view:

- `no_visible_mode` — the agent has no visible profile.
- `visible_failed` — the pane failed to launch or take the prompt before the turn started. The failed pane is closed and the operation is re-queued headless.

If every run fails visibly, check the pane window: does the CLI start on its own outside Puppet Master? A CLI that prints a trust dialog, an update prompt, or a login screen before its composer is ready may be "updating your screens"; the app will ask before acting. Answer the prompt in the pane once, then retry.

## `OPENCODE_SERVER_UNREACHABLE`

The `opencode_native` backend drives an `opencode serve` process on loopback. If that process exits or restarts, an in-flight turn cannot make progress.

- Start a new run; the old session is not recoverable while the server is down.
- Check that `opencode` is on `PATH` and that its configured provider/auth still works.
- If it happens repeatedly, switch that run to `headless: true` or use another backend.

## A pane disappeared

Closing a pane window kills that pane. This is intentional: there is no grid to reattach to.

- Agent-spawned panes open unfocused; if a run's pane closes, `inspect_agent` reports `pane_disposed` and the receipt says whether the pane was kept.
- A crashed or killed pane is detected by the exit watcher. Start a new run with `followup_task` only if the worker session survived; otherwise use `run_agent`.
- `close_agent` is the explicit cleanup. Do not close user panes as cleanup.

## Agents are not found on `PATH`

The app inherits the environment of the process that launched it, not your current shell.

- Put `claude`, `codex`, `opencode`, and `cursor-agent` on `PATH`.
- On Windows, `cursor-agent` may be a `.ps1` shim.
- Restart the app from a shell where `where claude` (or `which claude`) succeeds.
- The Agent Store/doctor can install and verify agents; Settings > Agents shows the resolved binary.

## The phone cannot connect or the URL changed

- Cloudflare quick tunnels get a new URL on every app start. Re-pair or restart the tunnel.
- `PUPPET_MASTER_PUBLIC_URL` pins a stable public URL and skips cloudflared.
- Remote hosts use long-polling (`/events/poll`), not SSE; a `gap` means events were missed and the pane list is reloaded.
- A paired phone can type into panes a `run_agent` manages. Pairing state lives in `puppet-master.pairing.json`.

## Two workers collide on the same files

- Use project tasks and resource locks (`create_task`, `claim_task`, `acquire_resource_lock`).
- Or run each worker in its own worktree (`worktree_isolation: "worktree"` on `run_agent`; review with `review_worktree`).
- Night Shift and separate-copy runs use isolated copies by design.
- Collision alerts warn when two panes touch the same file, but the app never merges automatically.

## Tests

`cargo test --lib` builds the Rust crate only, but some tests and the desktop build expect the frontend `dist`:

```bash
npm run build --workspace=@puppet-master/app
cd packages/app/src-tauri && cargo test --lib
```

Other commands:

```bash
npm run test:fake-tui   # fake-TUI end-to-end (requires the dev-fake-tui feature)
npm run e2e             # real app over CDP/WebView2 (Windows)
npm run check:privacy   # catch personal paths in committed files
```

`cargo test` can be slow; CI uses `cargo nextest run --lib --bins`. See [TEST-PLAN.md](TEST-PLAN.md).

## Where to look for evidence

| Path | Contains |
|---|---|
| `<project>/.puppet-master/events.jsonl` | Coordination events |
| `<project>/.puppet-master/operations/<id>.json` | Operation snapshot, stage, receipt |
| `<project>/.puppet-master/operations/<id>.transcript.jsonl` | Typed transcript chunks |
| `<project>/.puppet-master/messages/` | Steering receipts |
| `<app data>/logs/` | App logs |
| `<app data>/crash/` | `panic-<ms>.log` (message, location, backtrace, last log lines) and `exits.log` (exit code and reason) |
| `<app data>/audit/` | Audit records |
| `<app data>/settings.json` | Settings |
| `<app data>/agents/` | Agent definitions and approvals |

Use `agent_transcript(handle)` and `inspect_agent(handle)` before reading files by hand; they return the same data with cursors.

## Still stuck

1. `bridge_health` — confirms bridge, build id, catalog version, and tool count.
2. `list_agents` — shows managed runs and adoptable panes.
3. `inspect_agent` — stage, status, error, capabilities.
4. `agent_transcript` — what the worker actually saw and said.
5. [docs/ENVIRONMENT.md](ENVIRONMENT.md) and [docs/wiki/developing.md](wiki/developing.md) for configuration and rebuild steps.
