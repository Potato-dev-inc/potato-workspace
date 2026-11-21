# Potato Worker (Puppet Master relay on Cloudflare)

The team relay ("Heads-up") as a Cloudflare Worker with one Durable Object per team. It speaks the
same wire protocol as the Rust server in `../server`, so the app's team settings work against it
unchanged: you only paste its address. It is end-to-end encrypted like the server: the relay sees team
ids, device public keys, sizes and times, never names, branches, notes or keys.

Use it when you want to host your own relay for free-ish, with no machine to keep running. (Prefer a
single binary or Docker? See [`../README.md`](../README.md).)

## Deploy

### From the app

Settings › Team › **Create team relay**. Make a Cloudflare API token with the "Edit Cloudflare Workers"
template, paste it, and the app uploads this Worker to your own account through the Cloudflare API (no
Node or wrangler needed), turns on its `workers.dev` address, waits for `/v1/health` and creates the
team with it. The token is used for that deploy only and not kept. Your account needs a `workers.dev`
subdomain: open Workers in the Cloudflare dashboard once if it has none.

What the app uploads is built from this folder by `scripts/bundle-for-app.mjs` (one JS module, the wasm
and a manifest read from `wrangler.toml`; the app build runs it). It uses the same Worker name and
migration tags as `wrangler.toml`, so `npm run deploy` later carries on from it, and the other way round.

### One click

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Potato-dev-inc/puppet-master/tree/main/relay/worker)

Cloudflare copies this folder into your own Git account, builds it and deploys it to your Cloudflare
account. You need a free Cloudflare account. The repository must be public for the button to work
(Cloudflare reads it without your credentials).

When it finishes you get an address like `https://pm-relay.<your-name>.workers.dev`. Open
`<address>/v1/health`: it should answer `{"ok":true,"protocol":"pm-relay/1"}`.

### By hand

```sh
cd relay/worker
npm install          # wrangler is a dev dependency of this folder, not installed globally
npx wrangler login   # once; opens your browser to sign in to your Cloudflare account
npm run deploy
```

Nothing needs building: the protocol checks are a WebAssembly file committed in `src/wasm/` (see
"How it works"). To try it on your own computer first: `npm run dev` serves it on
`http://127.0.0.1:8787` (no account, no login).

### Then, in Puppet Master

Settings › Team › Use my own address: paste the `https://…` address and create the team. Teammates' invite
links carry the relay address, so they don't type it. Use `https://`; the app only accepts plain
`http://` for a relay on the same computer.

## What it keeps, and for how long

Per team, in its Durable Object's SQLite storage:

| What | How long |
|---|---|
| Envelopes (ciphertext + sender device, epoch, counter) | 7 days (an alarm sweeps hourly; reads never return an expired one) |
| Join requests (sealed to the admin's device) | 1 day |
| The `roster` and `keys` slots and the access list (root-signed, opaque) | until replaced by a newer version |
| Replay guard (signatures seen in the last ~11 minutes) and rate-limit counters | minutes to a day, then swept |

Per client address, a counter for team registrations; the object is named by a hash of the address, so no
address is stored. Join requests are counted inside the team's own object under a hash of the address
(an IPv6 address by its /64), which expires after an hour. An idle team costs nothing: open WebSockets use Cloudflare's
hibernation API, so the object sleeps between messages.

## Limits

The same numbers as the server (`Limits` in `../server/src/lib.rs`):

- 60 envelopes a minute and 5,000 a day per device, 600 a minute per team, 24 KiB per envelope;
- 300 signed requests a minute per device, reads included (429);
- a team keeps at most 20,000 envelopes or 128 MiB (507 "the team's mailbox is full"; expiry frees it);
- at most 4 open WebSockets per device (429 "too many open connections for this device");
- join requests: 10 an hour per address and team, 200 a day per team, 5 per invite (checked in that order);
- 30 team registrations an hour per address; long polls up to 25 seconds.

To change a number, uncomment the matching `LIMIT_…` line under `[vars]` in `wrangler.toml` (they are listed there).

Cloudflare's own allowances apply on top (the free plan has daily request, duration and storage-row
limits: see Cloudflare's pricing page for Workers and Durable Objects). A message costs 8 storage-row writes here
(the envelope, the team's counters, four rate-limit counters, the replay guard) and about 2 more when its
replay-guard row expires and 1 when the envelope does; a read costs 3. Opening a socket and sending a message
cost one request each; the messages that arrive over an open socket cost nothing. For a team of five sending
200 messages each a day that is about 11,000 rows written a day, so the free plan (100,000 a day) holds
roughly eight such teams; more than that, or a team whose apps cannot use WebSockets, needs the paid plan.
`../HOSTED-RELAY.md` has the full estimate. A test (`npm run test:worker`) fails if a message starts costing more.

## Hardening (what the server's security review found, done here from the start)

- The mailbox counter only grows (a quiet week cannot make new mail invisible to a client's cursor).
- A request signature is stored only after the device is known to be on the team's access list, and expired
  ones are deleted on every call: strangers leave nothing behind.
- Rate-limit counters live in each team's own object, are pruned as they expire, and a team's daily join
  budget is spent before per-invite counters are created, so junk invite ids cannot grow them.
- A new envelope is built once and sent to every open socket; no database query per socket per message.
  Only a socket that is behind catches up with its own query. A device keeps at most 4 sockets (the fifth is
  refused with 429) and a client message over 4 KiB closes its socket.
- Per-address limits read `CF-Connecting-IP`, which Cloudflare sets and a client cannot forge, so the limit is
  per client and not for the whole relay. An IPv6 client counts by its /64, an IPv4-mapped one as its IPv4 address.
  Join requests are limited per address *and team*, so one address cannot close joining for other teams.
- A team's mailbox holds at most 20,000 envelopes or 128 MiB (`LIMIT_TEAM_MAX_ENVELOPES`, `LIMIT_TEAM_MAX_BYTES`);
  a full mailbox answers 507. The counters are kept in the team row and checked before the insert.
- **Join points.** A device added to the access list reads only what the team posts after it was added
  (`devices.from_seq`); everyone listed at registration reads from the start. Removing a device deletes its row
  and closes its socket and any long poll it has waiting (403), and adding it back gives it a new join point.
  Objects stored before this change are migrated when they wake: every listed device starts at 0 and the
  storage counters are filled from the rows.
- **A cursor ahead of the relay.** Every mailbox reply carries `head` (the team's newest position). When `after`
  is past it (a restored or replaced database), the reply says `"reset": true` and starts again from the device's
  join point; a WebSocket sends `{"reset":true,"head":N}` first. These shapes are `Batch`/`Resync` from
  `relay/protocol`, serialised by the wasm module.

Not covered here: a flood of badly signed requests costs the Worker one signature check each; if that worries
you, add a Cloudflare rate-limiting rule on the Worker's route (dashboard, Security > WAF).

## How it works

```
app (RelayTransport) ──HTTPS / WSS──▶ Worker (src/index.ts) ──▶ Team Durable Object (src/team.ts)
                                         │  size, signature, per-address limit      mailbox · access list · state
                                         └▶ IpGate Durable Object (src/gate.ts)     replay guard · limits · alarm
```

- **`src/index.ts`**: the front door. Sorts the route, refuses oversized bodies (413), checks the device
  signature, counts unauthenticated calls per address, then hands the request to the team's object.
- **`src/team.ts`**: one object per team: team exists, device on the access list, request not
  replayed, rate limits, SQLite storage, the long poll, WebSockets, and the expiry alarm.
- **Protocol checks are Rust.** `wasm/` is a tiny crate over `../protocol` (the MIT crate the app and the
  Rust server also use) compiled to WebAssembly. Every signature, shape and binding rule (strict
  Ed25519, the signed bytes, team id = hash of the root key, size and field checks) therefore *is*
  the shared code, not a port of it. The result is committed in `src/wasm/` so deploying needs no Rust.
- **Wire-compatible, not just similar:** same routes, status codes and error messages, same
  `Delivered`/`Batch` JSON, and a path prefix works because the app signs the path it used.

### Rebuilding the WebAssembly

Only needed when `../protocol` or `wasm/` changes:

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.129 --locked   # must match wasm/Cargo.toml
npm run build:wasm                                          # writes src/wasm/, prints the sha256
```

## Differences from the server

- No trusted-proxy setting: the server reads `X-Forwarded-For` only from proxies you list; the Worker reads
  `CF-Connecting-IP`, which Cloudflare sets. (That one test of the shared suite is axum-only.)
- Rate-limit windows and the replay guard live in the team's storage, not in memory (an object's memory can be
  evicted), so they cost row writes.
- Long polls hold a Durable Object awake for up to 25 seconds; clients use the WebSocket first, so this
  is the fallback. WebSockets hibernate.
- The WebSocket has no server ping (the Workers runtime cannot send one while hibernating). A client may send the
  text `ping` now and then: the runtime answers `pong` without waking the object, and Cloudflare closes a
  connection that stays silent for too long, so the app does this every 45 seconds. A dropped connection is
  noticed by the app, which falls back to polling and tries the socket again.
- Cloudflare terminates TLS, so there is nothing to put in front of it.

## Potato Worker: one Worker for the team, the phone and invites

This one deployment does three jobs. They share the Worker and nothing else (separate Durable Objects):

| Job | Routes | Object |
|---|---|---|
| Team relay and Live Rooms | `/v1/teams/...`, `/v1/rooms/...`, `/r/` | `Team`, `IpGate`, `Room`, `RoomIndex` |
| Stable phone link | `/_pm/link/...`, `/_pm/where`, and the phone page once a PC is linked | `StableLink` |
| Invite links | `/join/<code>`, `/v1/invites/<code>`, `/v1/teams/<team>/invite-links` | `InviteBox` (one per code) |

**One deploy:** `cd relay/worker && npm install && npx wrangler login && npm run deploy`. Keep the name `pm-relay`
to upgrade an earlier relay in place (a new name would be a new, empty Worker).

**Health says what it can do.** `GET /v1/health` and `GET /_pm/health` return
`{"ok":true,"protocol":"pm-relay/1","worker":"potato-worker/1","features":["team","rooms","stable-link","invites"]}`.
The app reads `features` before it sends anything. A Worker deployed before this merge lacks a feature, so the app
says "Update your Worker" with the one deploy command. A secret is only ever sent to an address that lists the
feature it is for: the stable link secret goes to `/_pm/link/...` on a Worker that lists `stable-link`, and nowhere else.

**The phone link points, it does not proxy.** The Worker owns `/v1/`, `/r/`, `/join/` and `/_pm/`. The phone link is
`GET /_pm/where`: `{"ok":true,"url":"https://<name>.trycloudflare.com"}` while a PC is linked (cacheable for 15 s), else
`503 {"ok":false}`. It makes no subrequest, is limited per address (60 a minute, in memory, 429 above it) and only ever
names an address that passes the quick-tunnel rule. The phone page loads from this Worker, asks `where`, and then sends every
API call, stream and WebSocket straight to that tunnel with its bearer token; the PC answers CORS for this Worker's origin
(workers.dev or your own domain, and any earlier address you used). The Worker no longer carries those calls: `/bridge/...`,
WebSocket upgrades and every non-GET request outside the owned prefixes are refused (404/405) without touching the PC. That
proxy cost a Worker request plus a subrequest per call and used up the free daily quota.

What is still fetched from the PC: only the phone page itself (`GET` of `index.html`, scripts, icons), with none of the
client's headers. Only page files (script, style, image, font, manifest, wasm) are kept in the edge cache: the phone server says
`no-store` on every file, and for these the Worker replaces it with `public, max-age=3600, s-maxage=600`, so a load costs this Worker
one request and the PC none. `index.html`, `sw.js`, `registerSW.js` and HTML answers (a deep link returns `index.html`) pass through with
the PC's own cache headers and are never kept. Serving
that page as true static assets (`[assets]` in `wrangler.toml`) would make it free, but needs the app's two deploy paths
(`team/worker_update.rs` and `relay_deploy.rs`) and `bundle-for-app.mjs` to ship and upload the built phone page: not done yet.
Before a PC is linked, `/` shows the relay's front page.

**Deploy order: the PC app first, then the Worker.** An older phone page (served by an older PC app) still calls `/bridge/...` on the
Worker. A new Worker answers those with `502 {"code":"BRIDGE_UNREACHABLE","message":"This phone page is out of date. Update Potato
Workspace on your PC, then open this link again."}`, the shape an older page already turns into a plain sentence, instead of failing
silently. So update Potato Workspace on the PC first (it brings the new phone page, which asks `/_pm/where`), then update the Worker.
The app's own "Update your Worker" step does it in that order.

**Invite links.** A team device asks the Worker for a link (`POST /v1/teams/<team>/invite-links`, signed like every
team call). The Worker makes a random 16-character code and keeps the invite for at most 24 hours.
`GET /v1/invites/<code>` says who invited and which team (it never burns). `POST /v1/invites/<code>/claim` hands out
the invite once and burns it: a second claim, from anyone, is a 410. `GET /join/<code>` is the page a person opens in a
browser ("Open the app" and a download link). It only looks, so a link preview cannot use the invite up. The team owner
still approves every join in the app. What the Worker stores for an invite is the invite itself (link and code), so a
Worker you do not trust could read an open invite: host your own, as with the relay.

Optional settings: `SETUP_SECRET_SHA256` (nobody can claim the phone link first), `RATE_LIMIT_PER_HOUR`,
`DOWNLOAD_URL` (where the invite page sends someone without the app). See `wrangler.toml`.

## Check your request usage

```sh
npm run usage                    # last 24 hours, Worker name from wrangler.toml
npm run usage -- --hours 6       # breakdowns for the last 6 hours
npm run usage -- --json          # the same numbers as JSON (no token, account id masked)
```

It reads how many requests the Worker has used from Cloudflare's analytics and prints, in plain English: the
day's total against the free plan's 100,000 requests per day, the busiest hours, a breakdown by HTTP status and by
data centre, and a verdict:

- **OK**: nothing unusual.
- **WATCH**: most of the last hour failed, or the latest 5 minutes ran above 5 requests per second, or the day is at 80% of the free allowance.
- **STORM**: both of the first two at once. Usually an old phone page or an old app is retrying. Close it, update it, or switch the Worker to the paid plan.

It only reads. It logs in with the token `npx wrangler login` already saved on your computer (or uses
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` if they are set). Run `npx wrangler login` again if it says the
login was rejected. The token is never printed. Exit codes: 0 OK or WATCH, 1 STORM, 2 not logged in or login rejected,
3 the login cannot read analytics, 4 any other error.

## Tests

```sh
npm test               # everything below
npm run test:worker    # the Worker's own tests (node:test) against two local `wrangler dev` servers
npm run test:app       # the Rust end-to-end tests, pointed at the local Worker
```

All of it runs on your computer under `wrangler dev` (Miniflare/workerd) with throwaway storage.
Nothing logs in to or deploys to Cloudflare. The Rust parts need `cargo`.

The Rust tests are the **same** end-to-end tests the server passes; set `PM_RELAY_TEST_URL` and they use
that relay instead of the in-process one:

- `relay/server/tests/protocol.rs`: registration, access list, replay, mailbox cursors and long polls,
  WebSocket backlog and live delivery, a removed device's socket closing, signed state slots, join
  requests, rate limits, `head`/`reset`, join points, a removed device's waiting poll, the per-device request
  cap, the storage quota (507) and the socket cap. Only `per_address_limits_read_forwarded_addresses_only_from_trusted_proxies`
  is axum-only.
- the app's `relay_end_to_end_create_invite_join_push_and_card_with_metadata_only_on_the_relay`,
  `on_the_relay_a_removed_member_is_locked_out_and_told_so` and
  `an_envelope_the_relay_drops_shows_up_as_a_gap` (`packages/app/src-tauri/src/team/tests_v1.rs`),
  which drive the real `RelayTransport`.

They need a few things only a test may do (look inside the store, drop an envelope, tighten a limit,
age the clock). Those are `/v1/_test/…` routes that exist only when `TEST_HOOKS=1` is set, which the test
runner does and a deployment never does.

## Licence

Pending the founder's decision, like the server: see [`LICENSE`](LICENSE). The protocol crate it is built
on is MIT.
