// The Puppet Master team relay as a Cloudflare Worker + Durable Objects.
//
// Same wire protocol as relay/server (axum + SQLite), so the app's `RelayTransport` works against
// it unchanged: same routes, same signed requests (`x-pm-auth`), same status codes and messages.
//
//   POST /v1/teams                          register a team (root-signed access list)
//   PUT  /v1/teams/{team}/acl               new access list (root-signed)
//   PUT|GET /v1/teams/{team}/state/{slot}   signed `roster` / `keys` slots
//   POST|GET /v1/teams/{team}/envelopes     the mailbox (GET long-polls with ?after=&wait=)
//   GET  /v1/teams/{team}/ws                the mailbox as a WebSocket (hibernating)
//   POST|GET /v1/teams/{team}/joins         sealed join requests
//   POST     /v1/rooms                      register a Live Room (signed by its room key)
//   PUT|DELETE|GET /v1/rooms/{room}/…       the owner's calls (signed) and the viewers' GETs (read token)
//   GET  /r/                                the Live Room viewer page (static, strict policy)
//   GET  /v1/health
//
// This file is the front door: it sorts the request, caps the body, checks the device signature
// (WebAssembly built from relay/protocol), counts team registrations per address, passes the client's
// address to the team's Durable Object (join requests are limited per address and team there), and
// hands the rest to `team.ts`, which owns every team's state. Live Room routes follow the same rules
// (`roomRoute` below) and are decided by `room.ts`.

import { addressKeyOf } from "./addr";
import { type Env, limitsFrom } from "./env";
import type { InviteBox } from "./invites";
import { addressKey } from "./gate";
import { readBody, refuse, json } from "./http";
import { scopedKey } from "./room";
import { authenticate, C, checkRegistration, isTeamId } from "./proto";
import { FEATURES, PAIR_FEATURE, WORKER_NAME } from "./features";
import { isHash, isRid, isToken, MAX_CT_CHARS } from "./pair";
import { codeKey, isCode, joinPage } from "./invites";
import { bearer, sha256Hex } from "./stablecrypto";
import { offlineResponse } from "./offline";
import { originRule } from "./stable";
import { isRoomId, isSeatId, parseRegistration, readHashOf, registrationError, ROOM, unb64 } from "./roomproto";
// The viewer, built by relay/viewer, is bundled as text (wrangler `[[rules]] type = "Text"`).
import viewerCss from "../../viewer/dist/viewer.css";
import viewerHtml from "../../viewer/dist/viewer.html";
// viewer.js is a plain script, not an ES module, so TypeScript cannot type its import; wrangler bundles it as text.
// @ts-expect-error see above
import viewerJs from "../../viewer/dist/viewer.js";

export { IpGate } from "./gate";
export { Room, RoomIndex } from "./room";
export { Team } from "./team";
export { StableLink } from "./stable";
export { InviteBox } from "./invites";
export { PairBox, PairIndex } from "./pair";

interface Spec {
  route: string;
  team?: string;
  slot?: string;
  /** Needs a device signature (`x-pm-auth`). */
  auth: boolean;
  /** Counts against the client address's registration budget (hourly, across all teams). */
  ip: boolean;
  /** Largest body, bytes. */
  max: number;
}

const NO_BODY = new Uint8Array(0);
const KIB = 1024;

/** Which route a request is, or `"method"` for a known path with the wrong method. */
function match(method: string, parts: string[], testHooks: boolean): Spec | "method" | undefined {
  if (parts[0] !== "v1") return undefined;
  if (parts.length === 2 && parts[1] === "teams") {
    return method === "POST" ? { route: "register", auth: false, ip: true, max: 8 * KIB } : "method";
  }
  if (parts[1] === "_test" && testHooks && parts.length === 4) {
    return { route: `test-${parts[3]}`, team: parts[2], auth: false, ip: false, max: 4 * KIB };
  }
  if (parts[1] !== "teams" || parts.length < 4) return undefined;
  const team = parts[2];
  switch (parts[3]) {
    case "acl":
      if (parts.length !== 4) return undefined;
      return method === "PUT" ? { route: "acl", team, auth: false, ip: false, max: 64 * KIB } : "method";
    case "state":
      if (parts.length !== 5) return undefined;
      if (method === "PUT") return { route: "state-put", team, slot: parts[4], auth: true, ip: false, max: C.maxStateBytes };
      return method === "GET" ? { route: "state-get", team, slot: parts[4], auth: true, ip: false, max: 0 } : "method";
    case "envelopes":
      if (parts.length !== 4) return undefined;
      if (method === "POST") return { route: "env-post", team, auth: true, ip: false, max: C.maxEnvelopeBytes };
      return method === "GET" ? { route: "env-get", team, auth: true, ip: false, max: 0 } : "method";
    case "ws":
      if (parts.length !== 4) return undefined;
      return method === "GET" ? { route: "ws", team, auth: true, ip: false, max: 0 } : "method";
    case "invite-links":
      if (parts.length !== 4) return undefined;
      return method === "POST" ? { route: "invite-put", team, auth: true, ip: false, max: 8 * KIB } : "method";
    case "joins":
      if (parts.length !== 4) return undefined;
      // Join requests are limited per address *and team*, by the team's object (it is given the address).
      if (method === "POST") return { route: "join-post", team, auth: false, ip: false, max: C.maxJoinBytes };
      return method === "GET" ? { route: "join-get", team, auth: true, ip: false, max: 0 } : "method";
    default:
      return undefined;
  }
}

// ------------------------------------------------------------------------------- Live Rooms

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
/** The one object that counts the relay's open rooms. */
const ROOM_INDEX_NAME = "open";

/** The viewer page's policy (SPEC-n32 §3.9): scripts and styles come from the relay itself only. */
const VIEWER_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; " +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const VIEWER: Record<string, { body: string; type: string }> = {
  "": { body: viewerHtml, type: "text/html; charset=utf-8" },
  "viewer.js": { body: viewerJs, type: "text/javascript; charset=utf-8" },
  "viewer.css": { body: viewerCss, type: "text/css; charset=utf-8" },
};

/** `/r/`, `/r/viewer.js`, `/r/viewer.css`. Undefined for any other path. */
function viewerPage(request: Request, url: URL): Response | undefined {
  if (url.pathname.includes("/v1/")) return undefined;
  const match = /\/r\/(viewer\.js|viewer\.css)?$/.exec(url.pathname);
  if (match === null) return undefined;
  if (request.method !== "GET") return refuse(405, "method not allowed");
  const file = VIEWER[match[1] ?? ""];
  return noStore(
    new Response(file.body, {
      headers: {
        "content-type": file.type,
        "content-security-policy": VIEWER_CSP,
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "cross-origin-opener-policy": "same-origin",
      },
    }),
  );
}

/** Room routes: which route a request is, or `"method"` for a known path with the wrong method. */
interface RoomSpec {
  route: "register" | "stop" | "status" | "snapshot-put" | "snapshot-get" | "frames-post" | "frames-get";
  /** Needs the owner's signature (`x-pm-auth`); otherwise a viewer's read token and seat. */
  owner: boolean;
  /** Largest body, bytes (0 refuses any body with 413). */
  max: number;
}

function matchRoom(method: string, parts: string[]): RoomSpec | "method" | undefined {
  if (parts.length === 2) {
    return method === "POST" ? { route: "register", owner: false, max: ROOM.maxRegistrationBytes } : "method";
  }
  if (parts.length === 3) return method === "DELETE" ? { route: "stop", owner: true, max: 0 } : "method";
  if (parts.length !== 4) return undefined;
  switch (parts[3]) {
    case "snapshot":
      if (method === "PUT") return { route: "snapshot-put", owner: true, max: ROOM.maxSnapshotBytes };
      return method === "GET" ? { route: "snapshot-get", owner: false, max: 0 } : "method";
    case "frames":
      if (method === "POST") return { route: "frames-post", owner: true, max: ROOM.maxFrameBytes };
      return method === "GET" ? { route: "frames-get", owner: false, max: 0 } : "method";
    case "status":
      return method === "GET" ? { route: "status", owner: true, max: 0 } : "method";
    default:
      return undefined;
  }
}

/** Every room answer is never cached (a stopped room must not be served from a cache). */
function noStore(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set("cache-control", "no-store");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

async function roomRoute(request: Request, env: Env, url: URL, parts: string[]): Promise<Response> {
  const spec = matchRoom(request.method, parts);
  if (spec === undefined) return noStore(refuse(404, "not found"));
  if (spec === "method") return noStore(refuse(405, "method not allowed"));
  // 1. The size first, before anything is parsed (relay/server's per-route body limit).
  const read = await readBody(request, spec.max);
  if (read instanceof Response) return noStore(read);
  return noStore(await roomHandle(request, env, url, parts, spec, read));
}

async function roomHandle(request: Request, env: Env, url: URL, parts: string[], spec: RoomSpec, body: Uint8Array): Promise<Response> {
  const address = addressKeyOf(request.headers.get("cf-connecting-ip"));
  if (spec.route === "register") return createRoom(request, env, address, body);
  const internal: Record<string, string> = { "x-pm-int-route": spec.route };
  if (spec.owner) {
    // 2. The owner's signature (relay/protocol, strict). Whether its key is the room's is the room's check.
    const header = request.headers.get(C.authHeader);
    if (!header) return refuse(401, "signed request required");
    const verdict = authenticate(header, request.method, url.pathname + url.search, body, Date.now());
    if (!verdict.ok) return refuse(verdict.status, verdict.error);
    internal["x-pm-int-device"] = verdict.device;
    internal["x-pm-int-sig"] = verdict.sig;
  } else {
    // 2. A viewer: counted per address, then the read token's shape (16 bytes) and the seat's shape. A bad
    // token is the same 404 as an unknown room.
    const gate = env.GATE.get(env.GATE.idFromName(await scopedKey("room-view", address)));
    if (!(await gate.hit(MINUTE_MS, limitsFrom(env).roomViewsPerMinute))) return refuse(429, "slow down");
    const token = unb64(request.headers.get(ROOM.readHeader) ?? "");
    if (token === undefined || token.length !== 16) return refuse(404, "not found");
    const seat = request.headers.get(ROOM.seatHeader) ?? "";
    if (!isSeatId(seat)) return refuse(400, "bad seat");
    internal["x-pm-int-read"] = await readHashOf(token);
    internal["x-pm-int-seat"] = seat;
    internal["x-pm-int-addr"] = await scopedKey("room-seat", address);
  }
  // 3. The room id (no object is made for a malformed one), then the room's own object decides the rest.
  const id = parts[2];
  if (!isRoomId(id)) return refuse(404, "not found");
  const answer = await toRoom(env, id, request, internal, body);
  if (spec.route === "stop" && answer.status === 204) await releaseSlot(env, id);
  return answer;
}

/** Registers a room: the address budget, the signature and shape, a slot among the open rooms, then the room. */
async function createRoom(request: Request, env: Env, address: string, body: Uint8Array): Promise<Response> {
  const gate = env.GATE.get(env.GATE.idFromName(await scopedKey("room-reg", address)));
  if (!(await gate.hit(HOUR_MS, limitsFrom(env).roomsPerAddressPerHour))) return refuse(429, "slow down");
  const reg = parseRegistration(body);
  if (reg === undefined) return refuse(400, "bad registration");
  const why = await registrationError(reg, Date.now());
  if (why !== undefined) return refuse(400, why);
  const index = env.ROOM_INDEX.get(env.ROOM_INDEX.idFromName(ROOM_INDEX_NAME));
  const slot = await index.reserve(reg.room, reg.expires_at_ms, limitsFrom(env).roomMaxOpen, Date.now());
  if (slot === "busy") return refuse(503, "the relay is busy, try again shortly");
  if (slot === "exists") return refuse(409, "room already exists");
  const made = await toRoom(env, reg.room, request, { "x-pm-int-route": "create" }, body);
  if (made.status !== 201) {
    await releaseSlot(env, reg.room);
    return made;
  }
  return json({ room: reg.room }, 201);
}

/** Passes a checked request to the room's object, with the internal headers the Worker verified. */
function toRoom(env: Env, room: string, request: Request, internal: Record<string, string>, body: Uint8Array): Promise<Response> {
  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) if (name.startsWith("x-pm-int-")) headers.delete(name);
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  for (const [name, value] of Object.entries(internal)) headers.set(name, value);
  const hasBody = request.method !== "GET" && request.method !== "HEAD" && body.byteLength > 0;
  const stub = env.ROOM.get(env.ROOM.idFromName(room));
  return stub.fetch(new Request(request.url, { method: request.method, headers, body: hasBody ? body : undefined }));
}

/** Gives a room's slot back among the open rooms (best effort: the slot ends with the room's time anyway). */
async function releaseSlot(env: Env, room: string): Promise<void> {
  try {
    await env.ROOM_INDEX.get(env.ROOM_INDEX.idFromName(ROOM_INDEX_NAME)).release(room);
  } catch {
    // The index prunes the row when the room's time is up.
  }
}

// ------------------------------------------------------------------------- invite links (/v1/invites, /join)

const INVITE_TRIES_PER_HOUR = 60;

/** An invite code's object, after the per-address budget. Unknown shapes are the same 404 as unknown codes. */
async function inviteBox(request: Request, env: Env, code: string): Promise<DurableObjectStub<InviteBox> | Response> {
  if (!isCode(code)) return refuse(404, "invite not found");
  const gate = env.GATE.get(env.GATE.idFromName(await scopedKey("invite-try", addressKeyOf(request.headers.get("cf-connecting-ip")))));
  if (!(await gate.hit(HOUR_MS, INVITE_TRIES_PER_HOUR))) return refuse(429, "slow down");
  return env.INVITES.get(env.INVITES.idFromName(await codeKey(code)));
}

function inviteAnswer(result: { state: string }): Response {
  const status = result.state === "unknown" ? 404 : result.state === "open" || result.state === "claimed" ? 200 : 410;
  return noStore(json(result, status));
}

/** `GET /v1/invites/{code}` (what to show, never burns) and `POST /v1/invites/{code}/claim` (burns). */
async function inviteRoute(request: Request, env: Env, parts: string[]): Promise<Response> {
  const code = parts[2] ?? "";
  const claim = parts.length === 4 && parts[3] === "claim";
  if (parts.length !== 3 && !claim) return noStore(refuse(404, "not found"));
  if (request.method !== (claim ? "POST" : "GET")) return noStore(refuse(405, "method not allowed"));
  const box = await inviteBox(request, env, code);
  if (box instanceof Response) return noStore(box);
  return inviteAnswer(claim ? await box.claim() : await box.peek());
}

/** `GET /join/{code}`: the page a person sees. It only peeks, so a link preview cannot use the invite up. */
async function joinRoute(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "GET") return refuse(405, "method not allowed");
  const code = url.pathname.slice("/join/".length).replace(/\/$/, "");
  const box = await inviteBox(request, env, code);
  const peek = box instanceof Response ? ({ state: "unknown" } as const) : await box.peek();
  return noStore(await joinPage(isCode(code) ? code : "", url.host, peek, env.DOWNLOAD_URL));
}


// ------------------------------------------------------------------------------- far-away pairing (/v1/pair)

/** The feature is on only when the owner key is set. Off: every pair route is the same 404 as any unknown path. */
const pairOn = (env: Env): boolean => typeof env.PAIR_OWNER === "string" && env.PAIR_OWNER.length > 0;

const PAIR_POLLS_PER_MINUTE = 600;
const PAIR_CREATES_PER_HOUR = 30;
const PAIR_CREATE_BODY = 1024;
const PAIR_MSG_BODY = MAX_CT_CHARS + 512;
const PAIR_INDEX_NAME = "open";

const pairAnswer = (status: number, body: unknown): Response => noStore(status === 204 ? new Response(null, { status, headers: { "content-encoding": "identity" } }) : json(body, status));

/**
 * `POST /v1/pair` (the owner opens a box), `POST /v1/pair/{rid}/claim`, `POST|GET /v1/pair/{rid}/msg`,
 * `DELETE /v1/pair/{rid}`. The box's object decides who may do what; this door checks the owner's signature,
 * the shapes and the per-address counts.
 */
async function pairRoute(request: Request, env: Env, url: URL, parts: string[]): Promise<Response> {
  if (!pairOn(env)) return noStore(refuse(404, "not found"));
  const address = addressKeyOf(request.headers.get("cf-connecting-ip"));
  if (parts.length === 2) {
    if (request.method !== "POST") return noStore(refuse(405, "method not allowed"));
    return pairCreate(request, env, url, address);
  }
  const rid = parts[2] ?? "";
  if (!isRid(rid)) return noStore(refuse(404, "not found"));
  const sub = parts.length === 4 ? parts[3] : parts.length === 3 ? "" : undefined;
  const route = sub === "" && request.method === "DELETE" ? "delete" : sub === "claim" && request.method === "POST" ? "claim" : sub === "msg" && request.method === "POST" ? "post" : sub === "msg" && request.method === "GET" ? "poll" : undefined;
  if (route === undefined) return noStore(refuse(sub === undefined ? 404 : 405, sub === undefined ? "not found" : "method not allowed"));
  // Every call is counted per address, so a stranger cannot make the Worker work for nothing.
  const gate = env.GATE.get(env.GATE.idFromName(await scopedKey("pair-poll", address)));
  if (!(await gate.hit(MINUTE_MS, PAIR_POLLS_PER_MINUTE))) return noStore(refuse(429, "slow down"));
  const read = route === "post" ? await readBody(request, PAIR_MSG_BODY) : NO_BODY;
  if (read instanceof Response) return noStore(read);
  const header = (name: string): string | undefined => {
    const value = request.headers.get(name) ?? undefined;
    return value !== undefined && isToken(value) ? value : undefined;
  };
  const who = { pair: header("x-pm-pair"), host: header("x-pm-host"), claim: header("x-pm-claim") };
  const box = env.PAIRS.get(env.PAIRS.idFromName(rid));
  if (route === "claim") {
    const out = await box.claim(who);
    return pairAnswer(out.status, out.body);
  }
  if (route === "delete") {
    const out = await box.remove(who);
    if (out.status === 204) await releasePair(env, rid);
    return pairAnswer(out.status, out.body);
  }
  if (route === "poll") {
    const forDir = url.searchParams.get("for") ?? "";
    const after = Number(url.searchParams.get("after") ?? "0");
    const out = await box.poll(who, forDir, after);
    return pairAnswer(out.status, out.body);
  }
  let message: { from?: unknown; n?: unknown; ct?: unknown };
  try {
    message = JSON.parse(new TextDecoder().decode(read)) as typeof message;
  } catch {
    return noStore(refuse(400, "bad message"));
  }
  const out = await box.post(who, String(message.from), Number(message.n), String(message.ct));
  return pairAnswer(out.status, out.body);
}

/** The owner opens a box: a signed request (key = PAIR_OWNER), a per-address count, a slot among the open boxes, then the box. */
async function pairCreate(request: Request, env: Env, url: URL, address: string): Promise<Response> {
  const read = await readBody(request, PAIR_CREATE_BODY);
  if (read instanceof Response) return noStore(read);
  const header = request.headers.get(C.authHeader);
  if (!header) return noStore(refuse(401, "signed request required"));
  const verdict = authenticate(header, request.method, url.pathname + url.search, read, Date.now());
  if (!verdict.ok) return noStore(refuse(verdict.status, verdict.error));
  if (verdict.device !== env.PAIR_OWNER) return noStore(refuse(403, "not the owner of this relay"));
  const gate = env.GATE.get(env.GATE.idFromName(await scopedKey("pair-create", address)));
  if (!(await gate.hit(HOUR_MS, PAIR_CREATES_PER_HOUR))) return noStore(refuse(429, "slow down"));
  let b: { rid?: unknown; pair_hash?: unknown; host_hash?: unknown; ttl_ms?: unknown };
  try {
    b = JSON.parse(new TextDecoder().decode(read)) as typeof b;
  } catch {
    return noStore(refuse(400, "bad request"));
  }
  if (typeof b.rid !== "string" || !isRid(b.rid) || typeof b.pair_hash !== "string" || !isHash(b.pair_hash) || typeof b.host_hash !== "string" || !isHash(b.host_hash)) {
    return noStore(refuse(400, "bad request"));
  }
  // A life is a number of milliseconds between 1 and ten minutes (a short one is lifted to the minimum by the box).
  const ttl = b.ttl_ms === undefined ? 600_000 : b.ttl_ms;
  if (typeof ttl !== "number" || !Number.isFinite(ttl) || ttl <= 0 || ttl > 600_000) return noStore(refuse(400, "bad request"));
  const max = Number(env.LIMIT_PAIR_MAX_OPEN ?? "") || 50;
  const index = env.PAIR_INDEX.get(env.PAIR_INDEX.idFromName(PAIR_INDEX_NAME));
  const slot = await index.reserve(b.rid, Date.now() + Math.min(ttl, 600_000) + 60_000, max, Date.now());
  if (slot === "busy") return noStore(refuse(503, "the relay is busy, try again shortly"));
  if (slot === "exists") return noStore(refuse(409, "exists"));
  const out = await env.PAIRS.get(env.PAIRS.idFromName(b.rid)).create(b.rid, b.pair_hash, b.host_hash, ttl);
  if (out.status !== 201) await releasePair(env, b.rid);
  return pairAnswer(out.status, out.body);
}

async function releasePair(env: Env, rid: string): Promise<void> {
  try {
    await env.PAIR_INDEX.get(env.PAIR_INDEX.idFromName(PAIR_INDEX_NAME)).release(rid);
  } catch {
    // the index prunes expired rows by itself
  }
}

// ------------------------------------------------------------------------------- stable phone link

const LINK_PREFIX = "link/";
const MAX_REGISTER_BODY = 1024;

function stableJson(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

/** What the Worker can do. The app reads `features` before it sends anything (a secret goes only where it is listed). */
const healthBody = (env: Env) => ({ ok: true, protocol: C.protocol, worker: WORKER_NAME, features: pairOn(env) ? [...FEATURES, PAIR_FEATURE] : FEATURES });

/** The one stable-link object: one Worker serves one PC. */
const linkOf = (env: Env) => env.LINK.get(env.LINK.idFromName("link"));

async function readOrigin(request: Request): Promise<unknown> {
  try {
    const text = await request.text();
    if (text.length > MAX_REGISTER_BODY) return null;
    return (JSON.parse(text) as { origin?: unknown }).origin;
  } catch {
    return null;
  }
}

/** The new secret of a rotate (`{"new_secret": "..."}`), as its SHA-256; null when missing or not a usable secret. */
async function readNewSecretHash(request: Request): Promise<string | null> {
  try {
    const text = await request.text();
    if (text.length > MAX_REGISTER_BODY) return null;
    const next = (JSON.parse(text) as { new_secret?: unknown }).new_secret;
    return typeof next === "string" && /^[!-~]{16,200}$/.test(next) ? await sha256Hex(next) : null;
  } catch {
    return null;
  }
}

/** `/_pm/health`, `/_pm/link/health`, `/_pm/link/register`, `/_pm/link/reset`. The link secret only ever arrives here. */
async function pmRoute(request: Request, env: Env, path: string): Promise<Response> {
  if (path === "where") return whereRoute(request, env);
  if (path === "health") {
    return request.method === "GET" ? noStore(json(healthBody(env))) : stableJson(405, { error: "method_not_allowed" });
  }
  if (!path.startsWith(LINK_PREFIX)) return stableJson(404, { error: "not_found" });
  const name = path.slice(LINK_PREFIX.length);
  const stub = linkOf(env);
  if (name === "health") {
    if (request.method !== "GET") return stableJson(405, { error: "method_not_allowed" });
    return stableJson(200, await stub.health());
  }
  if (name !== "register" && name !== "reset") return stableJson(404, { error: "not_found" });
  if (request.method !== "POST") return stableJson(405, { error: "method_not_allowed" });
  const token = bearer(request.headers.get("authorization"));
  if (!token) return stableJson(401, { error: "secret_required" });
  const hash = await sha256Hex(token);
  const address = request.headers.get("cf-connecting-ip") ?? "unknown";
  const outcome = name === "reset" ? await stub.reset(hash, await readNewSecretHash(request), address) : await stub.register(hash, await readOrigin(request), address);
  if (outcome.status === 200) forgetWhere();
  return outcome.status === 200 ? stableJson(200, { ok: true }) : stableJson(outcome.status, { error: outcome.error });
}

/** Turn an address the PC sent back (a redirect) into one on this Worker, so the phone never leaves it. */
function rewriteLocation(location: string, origin: string, self: URL): string {
  return location.startsWith(origin) ? `${self.origin}${location.slice(origin.length)}` : location;
}

// ------------------------------------------------------------------------------- where the PC is (point, do not proxy)
//
// The permanent link only POINTS at the PC's quick tunnel. The phone asks `GET /_pm/where`, then talks to the tunnel
// directly (the PC answers CORS for this Worker's origin). The Worker never carries the phone's API calls or sockets:
// each one used to cost a Worker request plus a subrequest, which blew the free quota.

const WHERE_PER_MINUTE = 60;
const WHERE_MAX_AGE_S = 15;
const WHERE_MEMO_MS = 5_000;
const MAX_TRACKED_IPS = 2000;
const whereHits = new Map<string, { start: number; count: number }>();
let whereMemo: { at: number; origin: string | null } | null = null;

/** Per-address limit in this isolate's memory (no Durable Object, no subrequest). False when over the limit. */
function whereAllowed(ip: string, now: number): boolean {
  if (whereHits.size >= MAX_TRACKED_IPS) {
    for (const [key, w] of whereHits) if (now - w.start >= 60_000) whereHits.delete(key);
    if (whereHits.size >= MAX_TRACKED_IPS) whereHits.clear();
  }
  const w = whereHits.get(ip);
  if (!w || now - w.start >= 60_000) {
    whereHits.set(ip, { start: now, count: 1 });
    return true;
  }
  w.count += 1;
  return w.count <= WHERE_PER_MINUTE;
}

/** A new address was registered or reset on this isolate: the next `where` reads it at once. */
function forgetWhere(): void {
  whereMemo = null;
}

/** The linked PC's address through the 5 s in-isolate memo, shared by `where` and the page files: a page open is not one Durable Object call per file. */
async function currentOrigin(env: Env, now: number): Promise<string | null> {
  if (!whereMemo || now - whereMemo.at >= WHERE_MEMO_MS) whereMemo = { at: now, origin: await linkOf(env).origin() };
  return whereMemo.origin;
}

async function whereRoute(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return stableJson(405, { error: "method_not_allowed" });
  const now = Date.now();
  if (!whereAllowed(request.headers.get("cf-connecting-ip") ?? "unknown", now)) {
    return new Response('{"ok":false}', { status: 429, headers: { "content-type": "application/json", "cache-control": "no-store", "retry-after": "30" } });
  }
  const origin = await currentOrigin(env, now);
  // The stored origin passed the quick-tunnel rule when it was registered; check again so nothing else is ever handed out.
  if (!origin || !originRule(env).test(origin)) {
    return new Response('{"ok":false}', { status: 503, headers: { "content-type": "application/json", "cache-control": "no-store", "retry-after": "10" } });
  }
  return new Response(JSON.stringify({ ok: true, url: origin }), {
    headers: { "content-type": "application/json", "cache-control": `public, max-age=${WHERE_MAX_AGE_S}` },
  });
}

/** What an older phone page shows when it still calls `/bridge` here (it reads `message` of a 502 `BRIDGE_UNREACHABLE`). */
const OLD_PAGE_SENTENCE = "This phone page is out of date. Update Potato Workspace on your PC, then open this link again.";

/**
 * The calls this Worker no longer carries: the phone API (`/bridge`), the dev-info file and every WebSocket. Answered before any
 * Durable Object or the PC is touched. The 502 + `BRIDGE_UNREACHABLE` + `message` shape is the one an older phone page already turns
 * into a plain sentence, so a Worker updated before the PC app tells the person what to do instead of failing silently.
 */
function refuseProxyCall(request: Request, path: string): Response | undefined {
  if (path === "/bridge" || path.startsWith("/bridge/") || path.startsWith("/__puppet_master_dev__")) {
    return new Response(JSON.stringify({ code: "BRIDGE_UNREACHABLE", error: OLD_PAGE_SENTENCE, message: OLD_PAGE_SENTENCE, reason: "not_proxied" }), {
      // 410 Gone, not 502: an old page that retries on 5xx in a tight loop burned the free daily quota. `Clear-Site-Data` makes a
      // browser drop this page's cache, storage and service worker (the stale copy that keeps calling), and `retry-after` slows the rest.
      status: 410,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        "retry-after": "3600",
        "clear-site-data": '"cache", "storage"',
      },
    });
  }
  if ((request.headers.get("upgrade") ?? "").toLowerCase() === "websocket") {
    return new Response(JSON.stringify({ error: "not_proxied" }), { status: 410, headers: { "content-type": "application/json", "cache-control": "no-store", "retry-after": "3600" } });
  }
  return undefined;
}

/** What may be kept at the edge: the page's script, style, image, font, manifest and wasm files. Not HTML (a deep link answers `index.html`), never an API answer. */
const CACHEABLE_TYPE = new RegExp("^(text/css|text/javascript|application/javascript|application/manifest[+]json|application/wasm|image/|font/|application/font)", "i");
/** These two must always be asked fresh: a new app version replaces the page and its service worker. The PC's own cache headers stay as they are. */
const ALWAYS_FRESH = new Set(["/", "/index.html", "/sw.js", "/registerSW.js"]);

/** Page files by path shape. Only these paths are kept at the edge, and only these drop the query string on the PC fetch. */
const PAGE_FILE_PATH = /\.(m?js|css|webmanifest|json|wasm|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot)$/i;

/** Every page-file answer says `nosniff`: a browser must not sniff a cached script or style into another type. */
function withNosniff(res: Response): Response {
  res.headers.set("x-content-type-options", "nosniff");
  return res;
}

/**
 * The phone page itself (index.html, scripts, icons): the only thing still fetched from the PC, GET only, with none of
 * the client's headers. Page files (html/js/css/images/fonts/manifest/wasm) are kept at the edge so a load costs this Worker
 * one request and the PC none; `index.html` and `sw.js` pass through with the PC's own cache headers and are never kept.
 *
 * The edge key is the path plus the registered tunnel host (the host of the address `currentOrigin` returns, read through
 * the same 5 s memo). A file cached under one tunnel address can therefore never be served after another address is
 * registered. With no address (unlinked) nothing is served from the cache at all.
 */
async function shellFromPc(request: Request, env: Env, self: URL): Promise<Response | undefined> {
  const isRead = request.method === "GET" || request.method === "HEAD";
  const fresh = ALWAYS_FRESH.has(self.pathname);
  // Page-file paths are fetched and cached without the query string, so the key and the PC's answer always agree.
  const cacheable = !fresh && isRead && PAGE_FILE_PATH.test(self.pathname);
  const origin = await currentOrigin(env, Date.now());
  // Not linked yet: the caller falls through to the relay's own front page, and nothing is served from the cache.
  if (!origin) return undefined;
  if (!isRead) return stableJson(405, { error: "method_not_allowed" });
  // The stored address passed the quick-tunnel rule when it was registered; check again before any fetch or cache use (as `where` does).
  if (!originRule(env).test(origin)) return offlineResponse();
  const cache = cacheable ? (globalThis as { caches?: { default?: Cache } }).caches?.default : undefined;
  const key = cache
    ? new Request(`${self.origin}${self.pathname}?pm-tunnel=${encodeURIComponent(new URL(origin).host)}`, { method: "GET" })
    : undefined;
  // A hit is answered with no Durable Object call beyond the memo and no request to the PC.
  const hit = key ? await cache?.match(key).catch(() => undefined) : undefined;
  if (hit) return withNosniff(request.method === "HEAD" ? new Response(null, hit) : new Response(hit.body, hit));
  const headers = new Headers();
  const accept = request.headers.get("accept");
  if (accept) headers.set("accept", accept);
  let upstream: Response;
  try {
    upstream = await fetch(`${origin}${self.pathname}${cacheable ? "" : self.search}`, { method: "GET", headers, redirect: "manual" });
  } catch {
    return offlineResponse();
  }
  if (upstream.status === 502 || upstream.status === 530) return offlineResponse();
  const out = new Response(upstream.body, upstream);
  const location = out.headers.get("location");
  if (location) out.headers.set("location", rewriteLocation(location, origin, self));
  out.headers.delete("set-cookie");
  if (cacheable) {
    withNosniff(out);
    if (upstream.status === 200 && CACHEABLE_TYPE.test(upstream.headers.get("content-type") ?? "")) {
      // The phone server says no-store on every file; for these page files (hashed names) the Worker's own header replaces it.
      out.headers.set("cache-control", "public, max-age=3600, s-maxage=600");
      if (cache && key) {
        try {
          await cache.put(key, out.clone());
        } catch {
          // an uncacheable answer is still an answer
        }
      }
    }
  }
  return out;
}

/** What the relay side owns: `/v1/...`, the Live Room viewer under `/r/`, `/join/...`, `/_pm/...`. Any other path is the phone page's. */
const ownedByRelay = (path: string): boolean =>
  path.startsWith("/v1/") || path === "/r/" || path === "/r/viewer.js" || path === "/r/viewer.css";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/_pm/")) return pmRoute(request, env, url.pathname.slice("/_pm/".length));
    if (url.pathname.startsWith("/join/")) return joinRoute(request, env, url);
    if (!ownedByRelay(url.pathname)) {
      // Refuse what is not carried here first (no object, no PC touched), then serve the phone page from the PC.
      const refused = refuseProxyCall(request, url.pathname);
      if (refused) return refused;
      // Not linked yet (`undefined`): the relay's own front page, as before.
      const shell = await shellFromPc(request, env, url);
      if (shell) return shell;
    }
    const page = viewerPage(request, url);
    if (page !== undefined) return page;
    // The relay may live under a path prefix (`https://example.com/pm/v1/...`); the app signs the
    // path it used, prefix included, so verify exactly what arrived.
    const at = url.pathname.indexOf("/v1/");
    if (at < 0) {
      return url.pathname === "/" ? new Response("Puppet Master team relay\n", { headers: { "content-type": "text/plain" } }) : refuse(404, "not found");
    }
    const parts = url.pathname.slice(at + 1).split("/");
    if (parts.length === 2 && parts[1] === "health") {
      return request.method === "GET" ? noStore(json(healthBody(env))) : refuse(405, "method not allowed");
    }
    if (parts[1] === "invites") return inviteRoute(request, env, parts);
    if (parts[1] === "pair") return pairRoute(request, env, url, parts);
    if (parts[1] === "rooms") return roomRoute(request, env, url, parts);
    const spec = match(request.method, parts, env.TEST_HOOKS === "1");
    if (spec === undefined) return refuse(404, "not found");
    if (spec === "method") return refuse(405, "method not allowed");

    // 1. Size first, as relay/server does (its body limit answers before any handler).
    let body = NO_BODY;
    if (spec.max > 0) {
      const read = await readBody(request, spec.max);
      if (read instanceof Response) return read;
      body = read;
    }

    // 2. The device's signature: time, body hash and Ed25519, from relay/protocol.
    let device: string | undefined;
    let sig: string | undefined;
    if (spec.auth) {
      const header = request.headers.get(C.authHeader);
      if (!header) return refuse(401, "signed request required");
      const verdict = authenticate(header, request.method, url.pathname + url.search, body, Date.now());
      if (!verdict.ok) return refuse(verdict.status, verdict.error);
      device = verdict.device;
      sig = verdict.sig;
    }

    // 3. The client's address: `CF-Connecting-IP`, which Cloudflare sets and a client cannot forge, with an
    // IPv6 address reduced to its /64 (as relay/server does). Team registrations are counted per address here;
    // join requests are counted by the team's object, which is handed the (hashed) address.
    let address: string | undefined;
    if (spec.ip || spec.route === "join-post") {
      address = await addressKey(addressKeyOf(request.headers.get("cf-connecting-ip")));
    }
    if (spec.ip && address !== undefined) {
      const gate = env.GATE.get(env.GATE.idFromName(address));
      if (!(await gate.hit(3_600_000, limitsFrom(env).unauthenticatedPerIpPerHour))) return refuse(429, "slow down");
    }

    // 4. Which team's object.
    let team = spec.team;
    if (spec.route === "register") {
      const verdict = checkRegistration(body);
      if (!verdict.ok) return refuse(verdict.status, verdict.error);
      team = verdict.team;
    }
    if (team === undefined || !isTeamId(team)) return refuse(404, "unknown team");

    // 5. Hand over, with what was verified. Client-sent `x-pm-int-*` headers never get through.
    const headers = new Headers(request.headers);
    for (const name of [...headers.keys()]) if (name.startsWith("x-pm-int-")) headers.delete(name);
    headers.delete("content-length");
    headers.delete("transfer-encoding");
    headers.set("x-pm-int-route", spec.route);
    headers.set("x-pm-int-team", team);
    if (spec.slot !== undefined) headers.set("x-pm-int-slot", spec.slot);
    if (spec.route === "join-post" && address !== undefined) headers.set("x-pm-int-addr", address);
    if (device !== undefined && sig !== undefined) {
      headers.set("x-pm-int-device", device);
      headers.set("x-pm-int-sig", sig);
    }
    const stub = env.TEAM.get(env.TEAM.idFromName(team));
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    return stub.fetch(new Request(request.url, { method: request.method, headers, body: hasBody ? body : undefined }));
  },
} satisfies ExportedHandler<Env>;
