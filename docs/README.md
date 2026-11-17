# Puppet Master docs

Start with the path that matches what you are doing.

| I am… | Read |
|---|---|
| New to the product | [README](../README.md) → [wiki overview](wiki/README.md) → [concepts](wiki/concepts.md) |
| An orchestrator / MCP host | [orchestrator quickstart](orchestrator/quickstart.md) → [cheatsheet](orchestrator/mcp-cheatsheet.md) → [workflows](orchestrator/workflows.md) |
| A contributor | [developing](wiki/developing.md) → [repo map](REPO_MAP.md) → [CONTRIBUTING](../CONTRIBUTING.md) → [test plan](TEST-PLAN.md) |
| A coding agent working in this repo | [repo map](REPO_MAP.md) → [architecture](wiki/architecture.md) → [extending](wiki/extending.md) |
| Debugging a failure | [troubleshooting](TROUBLESHOOTING.md) → [environment](ENVIRONMENT.md) → [run lifecycle](wiki/run-lifecycle.md) |

---

## Product and handbook

| Doc | What it covers |
|---|---|
| [../README.md](../README.md) | Landing page: what it is, install, architecture, quick start |
| [wiki/README.md](wiki/README.md) | Handbook overview and product model |
| [wiki/architecture.md](wiki/architecture.md) | Layers, bridge, panes, project-local state |
| [wiki/concepts.md](wiki/concepts.md) | Panes, handles, operations, ownership, provenance |
| [wiki/run-lifecycle.md](wiki/run-lifecycle.md) | What `run_agent` actually does |
| [wiki/packages.md](wiki/packages.md) | Monorepo layout |
| [wiki/developing.md](wiki/developing.md) | Build, test, MCP rebuild, `build_id` |
| [wiki/extending.md](wiki/extending.md) | Add a tool or agent; where to change X |
| [wiki/glossary.md](wiki/glossary.md) | Shared vocabulary |
| [FEATURES.md](FEATURES.md) | Code-verified feature list with status and file locations |
| [UI-INVENTORY.md](UI-INVENTORY.md) | Every UI surface and setting |
| [commands.md](../commands.md) | Copy-paste host and spawn commands |

## Orchestrating workers over MCP

| Doc | What it covers |
|---|---|
| [orchestrator/README.md](orchestrator/README.md) | Playbook index and contract |
| [orchestrator/quickstart.md](orchestrator/quickstart.md) | First session loop |
| [orchestrator/agent-shell-modes.md](orchestrator/agent-shell-modes.md) | Agent vs shell mode, catalog gating, ownership |
| [orchestrator/mcp-cheatsheet.md](orchestrator/mcp-cheatsheet.md) | Tool choice, waits, receipts |
| [orchestrator/workflows.md](orchestrator/workflows.md) | Copy-paste flows |
| [orchestrator/opencode-native-worker.md](orchestrator/opencode-native-worker.md) | OpenCode-native backend |
| [orchestrator/token-efficiency.md](orchestrator/token-efficiency.md) | Context and token patterns |
| [orchestrator/benchmark.md](orchestrator/benchmark.md) | Backend benchmarking |
| [orchestrator/mcp-gui.md](orchestrator/mcp-gui.md) | Qt MCP console |
| [../MCP_HOSTS.md](../MCP_HOSTS.md) | Registering the MCP server |

## Development and operations

| Doc | What it covers |
|---|---|
| [REPO_MAP.md](REPO_MAP.md) | File/function map, invariants, error codes |
| [TEST-PLAN.md](TEST-PLAN.md) | Automated suites, manual/live cases, known flakes |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | Common failures and fixes |
| [ENVIRONMENT.md](ENVIRONMENT.md) | Environment variables and defaults |
| [mobile-terminal-bugs-and-fixes.md](mobile-terminal-bugs-and-fixes.md) | Mobile terminal behavior and fixes |
| [../ROUTING.md](../ROUTING.md) | Historical sidebar API-vs-CLI routing design |
| [../ROADMAP.md](../ROADMAP.md) | Planned work |
| [../CHANGELOG.md](../CHANGELOG.md) | Release history |

## Design and product

| Doc | What it covers |
|---|---|
| [../PRODUCT.md](../PRODUCT.md) | Product brief, users, constraints |
| [../DESIGN.md](../DESIGN.md) | Colors, type, layout, components |
| [design/cockpit-contract.md](design/cockpit-contract.md) | Cockpit UI contract |
| [../puppet-master-feedback.md](../puppet-master-feedback.md) | Collected product feedback |

## Feature notes

[FEATURES.md](FEATURES.md) is the status registry. The files in [features/](features/) are the design/implementation notes behind individual features. Highlights:

**Panes and desktop**
[agent-store.md](features/agent-store.md) · [agent-skill-pack.md](features/agent-skill-pack.md) · [account-profiles.md](features/account-profiles.md) · [ambient-and-titles.md](features/ambient-and-titles.md) · [checkpoints.md](features/checkpoints.md) · [clip-it.md](features/clip-it.md) · [collision-alert.md](features/collision-alert.md) · [focus-time.md](features/focus-time.md) · [live-preview.md](features/live-preview.md) · [one-brain.md](features/one-brain.md) · [settings-redesign.md](features/settings-redesign.md) · [simple-mode.md](features/simple-mode.md) · [toolbelt.md](features/toolbelt.md) · [turn-summary-and-away-digest.md](features/turn-summary-and-away-digest.md)

**Workflows**
[assign-an-issue.md](features/assign-an-issue.md) · [bring-all-my-chats.md](features/bring-all-my-chats.md) · [followups.md](features/followups.md) · [keep-going.md](features/keep-going.md) · [missions.md](features/missions.md) · [night-shift.md](features/night-shift.md) · [pick-for-me.md](features/pick-for-me.md) · [red-to-green.md](features/red-to-green.md) · [review-desk.md](features/review-desk.md) · [second-opinion.md](features/second-opinion.md) · [what-broke-it.md](features/what-broke-it.md) · [worktree-isolation.md](features/worktree-isolation.md) · [worktrees-ship.md](features/worktrees-ship.md)

**Agents and trust**
[agent-authority.md](features/agent-authority.md) · [agent-doctor-and-activity.md](features/agent-doctor-and-activity.md) · [agent-scores.md](features/agent-scores.md) · [approval-cards.md](features/approval-cards.md) · [canary-strict.md](features/canary-strict.md) · [device-caps.md](features/device-caps.md) · [doctor-installs.md](features/doctor-installs.md) · [handoff-detect.md](features/handoff-detect.md) · [hook-lane.md](features/hook-lane.md) · [package-check.md](features/package-check.md) · [typing-permit.md](features/typing-permit.md)

**Mobile, remote, and sharing**
[live-room.md](features/live-room.md) · [phone-lossless.md](features/phone-lossless.md) · [phone-restyle.md](features/phone-restyle.md) · [relay-worker.md](features/relay-worker.md) · [team-heads-up.md](features/team-heads-up.md) · [telegram.md](features/telegram.md) · [tunnel-and-push.md](features/tunnel-and-push.md)

**Hardening notes (dated branch reports)**
[fix-live-claude.md](features/fix-live-claude.md) · [fix-live-codex.md](features/fix-live-codex.md) · [fix-live-hunt.md](features/fix-live-hunt.md) · [fix-live-standby.md](features/fix-live-standby.md) · [fix-live-ui.md](features/fix-live-ui.md) · [review-fixes.md](features/review-fixes.md) · [trust-fixes.md](features/trust-fixes.md)

## Specs and plans

- [specs/panes-first/SPEC.md](specs/panes-first/SPEC.md) — the panes-first product model
- [specs/agent-definitions/SPEC.md](specs/agent-definitions/SPEC.md) — declarative agents (`SPEC`, format, choice, plan, report, phases T01–T37)
- [specs/agent-wizard/SPEC.md](specs/agent-wizard/SPEC.md) — agent wizard
- [specs/handoff/live-captures.md](specs/handoff/live-captures.md) — usage-limit capture notes
- [specs/hook-lane/PROBES.md](specs/hook-lane/PROBES.md) — hook lane probes
- [plans/wp7-ownership-lifecycle.md](plans/wp7-ownership-lifecycle.md), [wp8-watcher-contract.md](plans/wp8-watcher-contract.md), [wp9-pane-close.md](plans/wp9-pane-close.md), [agent-parity-plan.md](plans/agent-parity-plan.md) — design notes
- [perf/latency-baseline.md](perf/latency-baseline.md) — latency benchmark

## Security

- [security/2026-10-14-tunnel-auth-bypass.md](security/2026-10-14-tunnel-auth-bypass.md) — 0.1.x advisory (fixed in 0.1.5)
- [security/2026-10-14-postmortem-public.md](security/2026-10-14-postmortem-public.md) — public postmortem

## Historical

- [INTEGRATION-NIGHT.md](INTEGRATION-NIGHT.md) — dated merge and integration log

> Docs under `features/`, `plans/`, and `specs/` are point-in-time records. When they disagree with the code or [FEATURES.md](FEATURES.md), the code wins.
