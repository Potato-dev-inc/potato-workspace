[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

# Potato Workspace

**Run your AI coding agents side by side, let them hand work to each other, and get a receipt that says what really passed.**

Potato Workspace is a Windows desktop app. Your agents run in real panes that you can watch. One agent can give a job to another, and every job ends with a receipt: which model ran, which checks passed, and whether the agent was kept read-only.

---

## What you get

- **Visible agent panes.** Terminal or chat panes for Claude Code, Codex, OpenCode, Cursor Agent and more. You see what each agent does.
- **Agents that delegate.** One agent calls another with the MCP tool `run_agent`. The receipt shows the model, the verified checks, and whether read-only was enforced.
- **Several sign-ins per agent.** Use more than one account for the same agent.
- **One Inbox.** Questions and approvals from all your agents land in one place. A phone web app lets you answer them away from your desk.
- **Team relay.** Share heads-up cards with your team through a relay that runs on your own Cloudflare account.
- **Quick handoff.** The agent writes down where it is and how you like to work, then a fresh agent of the same kind picks it up.
- **Bring my chats.** Bring your past chats from another agent into the workspace.

Features marked "Labs (experimental)" in Settings are still changing. They are off by default.

---

## Install

Windows only for now. A Mac port is planned.

1. Open [Releases](https://github.com/Potato-dev-inc/potato-workspace/releases).
2. Download the `.msi` file from the latest stable version (v1.0.15). A beta (v1.0.16) is also listed there.
3. Run it and follow the welcome screen.

The app checks Releases when it starts and shows a banner when a new version is out.

---

## Use it from your agent

In the app, open **Settings > Bridge & MCP** and press **Add Potato Workspace to your agents**. It adds the skills and the connection for your agents, and you can undo it. The app has to be running.

Then ask your agent in plain words, or call the tool yourself:

```
run_agent {
  agent_type: "codex",
  project_path: "C:/work/my-app",
  task: "Review the last commit. Run the tests. Do not change files."
}
```

You get back a result and a receipt. Use `wait_agents` to collect results from several agents, and `followup_task` to continue the same chat.

More about the packs for each agent: [integrations/README.md](integrations/README.md).

---

## Build from source

You need Node 22, Rust, and the MSVC build tools on Windows.

```bash
npm ci
npm run tauri -- dev       # desktop app, dev mode
npm run build:rust         # build the installer
npm test
npm run typecheck
```

Installers are written to `packages/app/src-tauri/target/release/bundle/`.

Your agents' notes and runs for a project are kept in a `.potato-workspace/` folder inside that project. Add it to that project's `.gitignore`. Older `.puppet-master/` folders are imported.

---

## License

MIT. See [LICENSE](LICENSE).
