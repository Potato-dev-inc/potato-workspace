# Environment variables

Most users never need these: settings live in the app under **Settings**. Use environment variables for scripts, CI, multiple app-data profiles, or MCP host configs.

## Bridge and MCP

| Variable | Default | Purpose |
|---|---|---|
| `PUPPET_MASTER_BRIDGE_PORT_FILE` | `<app data>/puppet-master.bridge.port` | Port file the shim/CLI should read. Supports `%VAR%` expansion so host configs can use `%APPDATA%`. |
| `PUPPET_MASTER_PROFILE` | none | Named profile. Uses a separate app-data folder (`com.puppetmaster.app-<profile>`) and the profile port range (`17360–17399`). |
| `PUPPET_MASTER_MODE` | `agent` | Starting MCP mode: `agent`, `shell`, or `both`. Equivalent to `--mode`. |
| `PUPPET_MASTER_CLIENT_ID` | generated | Stable client identity for the MCP shim, used in coordination/audit records. |
| `PUPPET_MASTER_PANE_ID` | set by the app | Identifies the pane a launched agent is in. Do not set manually except in harnesses. |
| `PUPPET_MASTER_PARENT_RUN` | none | Internal: marks a run spawned by another run (budget/parent tracking). |
| `PUPPET_MASTER_HOOKS_DIR` | `<app data>/hooks` | Where agent hook files are written. Override for dev runs that must not touch the real folder. |
| `PUPPET_MASTER_TEST_MCP_BINARY` | none | Point integration tests at a specific MCP binary. |

The bridge binds loopback and scans upward from `17321`. The chosen `host:port` is written to the port file; a sibling `puppet-master.bridge.secret` holds the per-launch local secret sent as `X-PM-Local-Secret`.

## Desktop windows and startup

| Variable | Default | Purpose |
|---|---|---|
| `PUPPET_MASTER_NO_WINDOW` | unset | `1` / `true` starts headless (tray only). Same as `--no-window`. |
| `PM_WINDOW_ANCHOR` | none | Dev-only pane window anchor (`x,y`), normally injected from gitignored `pm-dev.local.json`. |
| `PUPPET_MASTER_HISTORY_HOME` | real home | Override the home directory scanned for imported agent chats. Intended for fixtures and tests. |
| `PUPPET_MASTER_TELEGRAM_API_BASE` | Telegram API | Point the Telegram channel at a local fake API in tests. |

## Tunnels, phones, and push

| Variable | Default | Purpose |
|---|---|---|
| `PUPPET_MASTER_TUNNEL` | enabled | `0` disables the Cloudflare quick tunnel. Profiles disable it unless set to `1`. |
| `PUPPET_MASTER_PUBLIC_URL` | none | Public base URL for pairing/phone access. Wins over the tunnel and skips cloudflared. |
| `NGROK_AUTHTOKEN` | none | Auth token for the ngrok dev tunnel path. |
| `PUPPET_MASTER_PUSH_HOSTS` | built-in suffixes | Extra comma-separated host suffixes allowed for web push. |
| `PUPPET_MASTER_VAPID_SUBJECT` | built-in contact | VAPID `sub` claim for push notifications. |

## CLI

| Variable | Default | Purpose |
|---|---|---|
| `PUPPET_MASTER_BIN` | discovered app binary | Binary `puppet-master worker` launches when it cannot attach to a running host. |
| `PUPPET_MASTER_CLI` | staged CLI bundle | CLI path embedded in `watch_command` results. |
| `PUPPET_MASTER_WATCH_SHELL` | `none` | Shell hint for `puppet-master watch` notifications (`powershell`, `bash`, …). |
| `PUPPET_MASTER_WORKER` | unset | Internal marker set on worker-host processes. |
| `PUPPET_MASTER_WORKER_AGENT` | unset | Internal: agent for a standalone worker host. |
| `PUPPET_MASTER_WORKER_CWD` | unset | Internal: working directory for a standalone worker host. |
| `PUPPET_MASTER_WORKER_PANE_ID` | unset | Internal: pane id for a standalone worker host. |

## Build and test

| Variable | Default | Purpose |
|---|---|---|
| `SKIP_RELEASE_UPLOAD` | unset | `1` builds installers without uploading to GitHub Releases. |
| `PM_BUILD_ID` | stamped | Build identifier embedded in receipts and `GET /health`. |
| `PM_FORCE_NEW_BUILD_ID` | unset | `1` forces a new debug build id even when sources did not change. |
| `PM_WIZARD_BENCH` | unset | Enables the agent-wizard benchmark harness. |
| `PM_WIZARD_BENCH_DIR` | unset | Fixture directory for the wizard benchmark. |
| `PM_WIZARD_BENCH_STEP`, `PM_WIZARD_BENCH_ROUND`, `PM_WIZARD_BENCH_OMIT` | unset | Benchmark selection knobs. |
| `PUPPET_MASTER_GH` | `gh` | Fake GitHub CLI used by fake-TUI CI/issue tests. |
| `PUPPET_MASTER_AGENT_MODE_OK` | unset | Test flag for fake TUI agent-mode checks. |
| `PUPPET_MASTER_WB_EXEC_TEST` | unset | Test hook for checkpoint bisect execution. |
| `VITE_PUPPET_MASTER_WORKER` | unset | Dev: route the Vite app to the worker-host shell. |
| `TAURI_DEBUG` | unset | Dev: disable minification and emit source maps. |

## App data locations

| OS | Path |
|---|---|
| Windows | `%APPDATA%\com.puppetmaster.app` |
| macOS | `~/Library/Application Support/com.puppetmaster.app` |
| Linux | `~/.local/share/com.puppetmaster.app` |

A named profile appends `-<profile>` to the folder name.
