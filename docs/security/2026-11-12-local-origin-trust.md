# 2026-11-12: any local web page was trusted as the desktop app

## Finding
A code review found that the bridge treated every loopback `Origin` (any port, and `*.localhost`) as the desktop app. A page served from any local dev server (for example `localhost:5173`, or a page previewed in the app) could call the bridge on `127.0.0.1:174xx` without a token and, because the bridge echoed `Access-Control-Allow-Origin` for that origin, read the answers. That reaches agents, panes and shell input.

## Fix
- Only these `Origin` values count as the app (`mobile_pairing::is_app_origin`, exact match): `tauri://localhost`, `http://tauri.localhost`, `https://tauri.localhost`, and in debug builds only the Vite dev origin taken from `devUrl` in `tauri.conf.json` (on `127.0.0.1` and `localhost`; read from the config, not hard-coded).
- Every other `Origin` (other localhost ports, `*.localhost`, `null`) needs a paired-device token and gets no `Access-Control-Allow-Origin`.
- No `Origin` header from a loopback peer with a loopback `Host` and no forwarder headers is still trusted (the MCP shim and CLI send none).

## Checked
- State-changing routes: the GET routes in `bridge/routes` and the other route modules are reads. Writes need POST/PATCH/DELETE, so an `<img>` or link request cannot act.
- Form posts (`text/plain`, urlencoded) skip the preflight but browsers still send `Origin`, so they hit the same rule (tested).
- WebSocket (`/events/ws`), SSE (`/events`) and poll run through the same `gate` before any handler (tested).
- Public paths (`/health`, `POST /pair`, pairing session, `POST /push/act`) are open to any origin by design; each has its own one-shot code or token.
- Preview windows (`preview-*`) match no capability window (existing test `point/tests/capabilities.rs`).
