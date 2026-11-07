# Potato Workspace

A Windows desktop app that runs your AI coding agents side by side: panes, terminals and chat, in one window.

## Install

Download the latest `.msi` from [Releases](https://github.com/Potato-dev-inc/potato-workspace/releases/latest) and run it.

The installer is not code-signed yet, so Windows SmartScreen may warn you. Choose **More info**, then **Run anyway**.

Node.js, npm, Git and cloudflared are included. You do not need to install them. The agents themselves, such as Claude or Codex, are separate products: install and sign in to the ones you use.

## Updates

The app checks Releases by itself. When a new version is out, click **Update** in the app, or use Settings > Version.

## Build from source

Needs Node.js 22 and Rust.

```bash
npm install
npm run tauri -- build --bundles msi
```

## Licence

MIT. See [LICENSE](LICENSE).
