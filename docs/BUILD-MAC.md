# Build Potato Workspace on a Mac

Status: **never built or run on a Mac yet.** The build files are prepared by reading the code. Expect to fix a few things on the first try, and write down the first error you see.

The result is an **unsigned** app and disk image for your own Mac. It is not for sharing.

## 1. What you need (once)

| Tool | Version | How |
| --- | --- | --- |
| Xcode Command Line Tools | any recent | `xcode-select --install` (this also gives you `git`, which the Mac app uses as its Git) |
| Rust | 1.91 or newer | install from rustup.rs, then `rustup update stable` |
| Node.js | 22 or newer (the repo needs `>=22`) | nodejs.org installer, or `brew install node@22` |
| Internet | | the build downloads Node 22.20.0, cloudflared and some npm packages (all checked against pinned hashes) |

Apple silicon (M1 or newer) and Intel both work. The app is built for the Mac you build on, so a build on Apple silicon will not run on an Intel Mac.

Check: `node -v` (22 or higher), `rustc -V` (1.91 or higher), `git --version`.

## 2. Get the code

```
git clone https://github.com/Potato-dev-inc/potato-workspace.git
cd potato-workspace
```

## 3. Build

```
npm ci
npm run tauri -- build
```

- `npm ci` installs exactly what `package-lock.json` says. It also downloads the cloudflared helper.
- `npm run tauri -- build` does everything else: builds the screens, fetches Node and cloudflared for your Mac, builds the Rust app and the small `puppet-master-mcp` helper, then packs the app and the disk image.
- The first build takes a long time (Rust compiles a few hundred crates, often 15 to 40 minutes). Later builds are much faster.
- On a Mac the file `packages/app/src-tauri/tauri.macos.conf.json` is merged over `tauri.conf.json` automatically. It selects the app and disk image, switches off the Windows-only update files, and signs with an ad-hoc signature.

If the build stops, run it again once. If it stops at the same place, keep the last 30 lines of output.

## 4. Where the result is

All under `packages/app/src-tauri/target/release/bundle/`:

- `macos/Potato Workspace.app` the app itself
- `dmg/Potato Workspace_<version>_<arch>.dmg` the disk image (`aarch64` = Apple silicon, `x64` = Intel)

To use it, open the `.dmg` and drag the app into Applications, or just double-click the `.app`.

A build made on your own Mac is not "downloaded", so macOS normally opens it without a warning. If macOS says the app is damaged or from an unidentified developer:

- right-click the app, choose Open, then Open again; or
- run `xattr -dr com.apple.quarantine "/Applications/Potato Workspace.app"` once.

## 5. Try it without a full build

```
npm ci
npm run dev
```

This opens the app with live screens. Use it to check that the app starts. It is a debug build, so it is slower than the real one.

## 6. Run it on GitHub instead (optional)

The workflow `.github/workflows/build-mac.yml` builds the same disk image on a GitHub Mac. It only runs when you press **Run workflow** (Actions tab, "Build Mac"). It uses no secrets, signs nothing and publishes nothing. When it ends, the `.dmg` is attached to the run as a download (an artifact, kept for a few days). Choose `macos-latest` (Apple silicon) or `macos-15-intel` (Intel).

## 7. Signing and notarization (not done)

- The build is signed with an ad-hoc signature (`signingIdentity: "-"` in `tauri.macos.conf.json`). That is enough for Apple silicon to run it on the Mac that built it.
- A copy sent to another Mac will be blocked by Gatekeeper (right-click, Open works on most Macs).
- To ship to other people you need an Apple Developer ID certificate, then signing with the hardened runtime and notarization. Node and cloudflared inside the app must be signed too, and Node needs the JIT entitlement. None of this is set up. **Never put Apple credentials in the repository.**
- Automatic updates are off on Mac (`createUpdaterArtifacts: false`, and `latest.json` has no Mac entry). To update, build again.

## 8. What works and what does not (from reading the code)

Compiles by design: every Windows-only crate (`windows`, `windows-sys`, `webview2-com`) sits behind `cfg(windows)`, and the code has Mac or Unix branches next to them. **Nobody has compiled the Mac branches yet**, because GitHub checks run on Windows only. The first `cargo` run on a Mac is the real test.

These parts are Windows-only. On a Mac they are off or do nothing, they do not stop the app from starting:

| Feature | On a Mac |
| --- | --- |
| WSL sandbox (Potato Bot "sandbox", WSL launch) | not available |
| AI browser pane controls (WebView2 DevTools: read page, click, console) | the pane opens, but the agent cannot drive it |
| Point and Fix screenshots (WebView2 capture) | not available |
| Windows toast notifications, taskbar badge | not available (no replacement yet) |
| Agent process tracking (`pty/agent_proc.rs` `snapshot()` returns nothing off Windows) | agent "alive / finished" detection and "Keep going" stop are weaker; panes may not notice that an agent ended |
| Pane process details and listening ports (`pane_jobs/sys.rs`) | empty |
| Pet "fullscreen app" check | always "no" |
| App-only updates, MSI install, in-app uninstall helper | Windows only |
| Git | uses the system git (Xcode tools), no bundled Git |
| Transparent windows (Ask bar, mode switch overlay) | drawn opaque (needs Tauri's `macos-private-api`, not enabled) |
| Window placement on Retina plus external screens, mini bar under the notch, Cmd+Q "agents still working" warning, Dock-icon reopen | not handled yet |

Mac-specific things that exist: Keychain storage for API keys (`keyring` apple-native), Launch Agent for "start at sign in", Cmd-based shortcuts, Mac default global shortcuts, `caffeinate` for Night Shift keep-awake, microphone and camera permission texts (`packages/app/src-tauri/Info.plist`).

## 9. Not tested (please try and report)

1. Does `npm ci` finish? Does `npm run tauri -- build` finish? If not, the first error lines.
2. Does the app open and show the cockpit? Does a terminal pane start your shell (zsh)?
3. Can you add an agent (for example Claude Code) and does it start? Is it found when the app is opened from Finder (the PATH comes from a login shell)?
4. Does the phone link work (QR code, tunnel with the bundled cloudflared)? macOS may ask to allow incoming connections: allow.
5. Does the microphone button in the message box ask for permission and dictate?
6. Do the bundled Node and cloudflared run on Apple silicon? (They are copied from official downloads. If macOS kills one of them, they need `codesign --force --sign -` run on them; tell the developer.)
7. Does Claude Code keep its login in the Keychain or in a file? This decides whether a copied login works on a Mac.

## 10. Troubleshooting

- `cargo: command not found`: open a new Terminal window after installing Rust.
- `error: linker 'cc' not found` or missing SDK: run `xcode-select --install`.
- Build says a resource folder does not match any file: the earlier `npm run build` step failed. Run `npm run build` inside `packages/app` and read the first error.
- To use a different cache folder for downloaded tools: set `PM_BUILD_CACHE`.
- To skip a download when you already have the tool staged: `PM_SKIP_NODE=1`, `PM_SKIP_CLOUDFLARED=1`.
