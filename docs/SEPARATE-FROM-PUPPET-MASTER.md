# Plan: separate Potato Workspace from Puppet Master

**Status:** proposed, not started. Nothing in this plan has been built.
**Repo:** https://github.com/Potato-dev-inc/potato-workspace
**Baseline:** `25664b5` ("Version 1.0.2") plus the uncommitted changes in the working tree, checked 2026-11-07

## Goal

Potato Workspace and Puppet Master share features and code history, but they are separate products. Each must work on its own, whether or not the other is installed or running.

All changes happen in `potato-workspace`. Puppet Master itself stays untouched.

## Why this is needed

A Haiku session in Potato Workspace's chat was asked to start a helper agent. It reported that "the Puppet Master tools aren't available" and told the owner to start the Puppet Master desktop app.

- **Confirmed:** the session ran through `claude-agent-acp`. None of its 16 deferred tools came from Puppet Master or Potato Workspace. It still loaded the skill named `puppet-master`.
- **Likely cause, not confirmed:** Potato Workspace attaches its tools to terminal panes (`src/pane_mcp`) but does not appear to do the same for chat. The chat session passes `self.cfg.mcp_servers` (`src/acp/session.rs`), and no default entry for its own tools was found.
- **Also likely involved:** the only `puppet-master` entry in the owner's `~/.claude.json` runs `npx -y @puppet-master/mcp` with Puppet Master's port file, and Puppet Master was not running.

Separately, a plain `npm run tauri -- build` published a Potato Workspace DMG to the public `puppet-master` repo, because the root `package.json` still points there.

## Current state

### Already separate

- App ID: `com.potatodev.workspace`
- Data folder: `~/Library/Application Support/com.potatodev.workspace`
- Keychain service: `com.potatodev.workspace` (`src/secrets.rs:22`)
- Updater address: the `potato-workspace` releases
- Terminal panes: use the bundled `Resources/bin/puppet-master-mcp` and Potato Workspace's own port file

### Still shared

Paths are under `packages/app/src-tauri/` unless they start elsewhere. Puppet Master's side is assumed from the shared code history, except the leftover port file and the `~/.claude.json` entry, which were seen on the owner's Mac.

| What | Where | Why it matters |
|---|---|---|
| Tool server name `puppet-master` | `src/agent_pack`, `src/pane_mcp`, `src/mcp_install` | Both products use the same key in agent configs, so they can overwrite each other, and agents cannot tell them apart |
| Skill and agent instructions | `integrations/skills/puppet-master`, `integrations/*` | Agents are told about Puppet Master |
| Project and home data folders | `<project>/.puppet-master/`, `~/.puppet-master/` (for example `src/budgets/store.rs:19`, `src/agent_runs/persist.rs`) | Same folder name for project data |
| Companion folders | `~/PuppetMaster/companions`, `~/.puppet-master/companion.json` (`src/companion/files.rs:20`, `:53`) | Same folder name for both |
| Bridge ports 17321-17399 | `src/bridge/mod.rs:138-139`, `src/app_paths.rs:54` | Puppet Master's leftover port file points at 17321, which Potato Workspace is using now. The tool program also tries 17321-17330 when it has no port file, so it can reach the wrong app |
| Phone port 1422 | `src/app_paths.rs:60` | Same default, so running both at once would clash |
| npm package `@puppet-master/mcp` | `packages/mcp-server/package.json:2` | The name belongs to Puppet Master |
| Port file names and env vars | `puppet-master.bridge.port`, `PUPPET_MASTER_BRIDGE_PORT_FILE` (`src/app_paths.rs:10-12`, `packages/shared/src/protocol.ts:82`) | The files sit in separate folders, but an inherited env var could still point at the other app |
| `puppet-master://` resource addresses | `src/tool_registry/extras.rs` | Same addresses as Puppet Master |
| Client name `puppet-master` | `src/acp/session.rs:480` | The app introduces itself to agents under the wrong name |
| Binary and crate names | `puppet_master_app`, `puppet_master_app_lib`, `puppet-master-mcp` (`Cargo.toml`) | Mostly cosmetic, but they keep causing this confusion |
| Repository address | Root `package.json:8`, `:11`, `:13` | Sends uploads and links to the wrong repo |

## Plan

Use a branch, not `main`. Commit each stage separately.

### Stage 1: Make releases safe

Do this first, so that no later build can publish by accident.

- Point `repository`, `bugs` and `homepage` in the root `package.json` at `potato-workspace`.
- Stop `scripts/with-cargo-path.mjs` from uploading after each build. Uploads should only happen through `npm run publish:release-assets`.
- In `scripts/publish-github-release-assets.mjs`:
  - use the `v1.0.2` tag format this repo already has, instead of `1-0-2`
  - name releases "Potato Workspace", instead of "Puppet Master"
  - actually create drafts by passing `--draft`, since the log already claims it does
  - change the `Potato-dev-inc/puppet-master` fallback, so it can never pick the old repo

**Done when:** `npm run tauri -- build` creates nothing on GitHub, and a publish run in dry-run or draft form targets `potato-workspace`.

### Stage 2: Give chat its own tools

- Confirm the cause first by starting a chat session and listing its tools.
- Attach Potato Workspace's own tool server to chat sessions, using the bundled program and its own port file.
- Do not rely on `npx`, or on anything from Puppet Master.

**Done when:** with Puppet Master quit, a chat session can start a helper agent.

### Stage 3: Rename what agents see

- Tool server key becomes `potato-workspace`, in `agent_pack`, `pane_mcp`, `mcp_install` and the golden test files.
- Skill folder and text become `potato-workspace`, with instructions that never mention the other app.
- Agent instructions and plugin manifests in `integrations/` follow the same rule.
- Resource addresses become `potato-workspace://`, and the client name becomes `potato-workspace`.
- Decide how the MCP tool program is delivered: its own npm package, or the bundled program only. See decision 2.
- Leave any `puppet-master` entry in a person's agent config alone. It belongs to Puppet Master.

**Done when:** a new Potato Workspace session sees only `potato-workspace` tools, and its instructions name only Potato Workspace.

### Stage 4: Separate the data

- Project data moves to `<project>/.potato-workspace/`.
- Home data moves to `~/.potato-workspace/`, and companions to `~/PotatoWorkspace/`.
- **Copy, don't move:** Puppet Master may still be using the old folders, so they are never deleted or changed. See decision 3.
- `.puppet-master/worktrees` needs care, because moving a git worktree breaks it. Existing worktrees stay where they are until they finish, and new ones go in the new folder.
- Check `.gitignore` handling for the new folder name.

**Done when:** Potato Workspace writes nothing to `.puppet-master/`, `~/.puppet-master/` or `~/PuppetMaster/`, and existing Potato Workspace data still shows up.

### Stage 5: Separate the ports

- Give Potato Workspace its own bridge range, away from 17321-17399, and update the range the tool program tries when it has no port file.
- Give it its own phone port, away from 1422.
- Rename the port and secret files and the `PUPPET_MASTER_*` env vars. An inherited `PUPPET_MASTER_*` value must be ignored.
- Keep profile ranges inside the new range. Update the tests that pin these numbers (`src/app_paths.rs:191-192`).

**Done when:** each app's tool program can only reach its own app, even with leftover port files in place.

### Stage 6: Clean up the remaining names

- Rename crates and binaries (`puppet_master_app`, `puppet-master-mcp`), `@puppet-master/*` packages, and comments and test strings.
- About 600 files and 1,700 lines mention the old name, across the Rust, UI, shared and MCP sources, so do this as a mostly mechanical change on its own.
- Renaming the app binary or the bundled tool program affects installed copies and updates, so check the updater before shipping.
- Update the README and docs.

**Done when:** a search for "puppet" in the repo finds only deliberate mentions, such as compatibility notes or license attributions.

### Stage 7: Test both ways

Run on Mac and on Windows. Windows needs a real PC, and has not been tested as part of this work.

**Potato Workspace alone**

- Puppet Master quit, and also with it uninstalled.
- With the existing `puppet-master` entry left in `~/.claude.json`.
- From a clean account with no Puppet Master files at all.
- Chat and terminal panes can both start helper agents.

**Both apps at once**

- Started in either order.
- Each agent reaches only its own tools.
- Each app writes only to its own folders, and its phone connection reaches itself.
- Quitting one does not affect the other.

**Upgrade**

- Existing Potato Workspace data, settings and secrets survive an update from 1.0.2.
- Puppet Master's data is byte-for-byte unchanged afterward.

**Automated guard**

- Add a guard test that fails if a production path, port, tool key or skill uses the Puppet Master names again.

## Decisions for the owner

The defaults below are recommendations. The owner has not confirmed them.

1. **Old project data:** default is to copy existing `.puppet-master/` data for Potato Workspace projects, leaving the original alone. The alternative is to start fresh, which is simpler but loses history such as budgets and checkpoints.
2. **Tool program:** default is the bundled program only. Publish a separate npm package later, if agents outside the app need it.
3. **Which old data is whose:** both apps may have written to the same folders, and the two sets cannot always be told apart. Default is to copy all of it for Potato Workspace, and accept that some Puppet Master history may appear there.
4. **Naming scope:** default is to do Stage 6 last, as its own change. It could be skipped for now, since Stages 1-5 are what make the products work independently.

## Related open items, not part of this plan

- **Accidental public release:** `1-0-2` ("Puppet Master 1.0.2") is still public and marked Latest on `Potato-dev-inc/puppet-master`, by the owner's choice for now. To remove it:
  - `gh release delete 1-0-2 --repo Potato-dev-inc/puppet-master --cleanup-tag --yes`
  - `gh release edit 0-2-2 --repo Potato-dev-inc/puppet-master --latest`
- **Broken public DMG:** `v1.0.2` on `potato-workspace` still has the DMG with the broken signature. The ad-hoc signing fix (`signingIdentity: "-"`) is uncommitted, and removing the warning completely needs a Developer ID.
- **Stray processes:** three `cloudflared` processes were seen running under Potato Workspace on port 1422. This has not been looked into.
