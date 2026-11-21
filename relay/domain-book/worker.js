// Potato Workspace "Address book" Worker, for "My domain" + Address book.
//
// It knows ONE thing: where your PC is right now (its current quick-tunnel address). Your PC tells it every time that
// address changes (`POST /_pm/link/register`, signed with a secret only your PC and you hold). A phone that opens your
// own name gets the phone page through this Worker; the phone then asks `GET /_pm/where` and talks to your PC straight.
//
// Nothing here names a domain: point any name of yours at the Worker (see wrangler.toml, `routes`) and it works. The same
// routes exist in the bigger Potato Worker (relay/worker), so the app treats both alike.
//
// The Worker is closed until it has a setup key: wrangler.toml carries SETUP_SECRET_SHA256 (the app fills it in). Without it
// nothing can be registered, and a reset never opens it up again. `GET /_pm/where?nonce=<hex>` also answers a proof
// (HMAC of the nonce with that hash) that only a Worker holding the right setup value can make; the app checks it before it
// sends this Worker any key.
//
// Safety: only `https://<name>.trycloudflare.com` can ever be stored (no open proxy), the secret is kept as a SHA-256
// hash, wrong-secret and flood attempts are counted per address, `/bridge` and WebSockets are refused (never carried).

const NAME = "pm-book/1";
const QUICK_RE = /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/;
const HOUR = 3_600_000;
const MAX_BODY = 1024;
const WHERE_PER_MINUTE = 60;
const REGISTER_PER_MINUTE = 20;
const MEMO_MS = 5_000;

const json = (status, body, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra } });

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a, b) {
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < length; i += 1) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

function bearer(header) {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  return match ? match[1] : null;
}

/** The one place the address lives. Plain `fetch` interface, so it needs no import. */
export class Book {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async allow(address) {
    const now = Date.now();
    const limit = Number.parseInt(this.env.RATE_LIMIT_PER_HOUR ?? "", 10) || 30;
    const all = (await this.state.storage.get("attempts")) ?? {};
    for (const [key, w] of Object.entries(all)) if (now - w.start >= HOUR) delete all[key];
    const keys = Object.keys(all);
    if (keys.length >= 1000 && !all[address]) delete all[keys[0]];
    const w = all[address] ?? { start: now, count: 0 };
    w.count += 1;
    all[address] = w;
    await this.state.storage.put("attempts", all);
    return w.count <= limit;
  }

  /** Who may act: only the setup value in wrangler.toml. With none configured nobody may (never "first one wins"). */
  who(hash) {
    const setup = (this.env.SETUP_SECRET_SHA256 ?? "").trim().toLowerCase();
    if (!setup) return "unconfigured";
    return safeEqual(hash, setup) ? "ok" : "wrong";
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/origin") {
      return json(200, { origin: (await this.state.storage.get("origin")) ?? null, updated_at: (await this.state.storage.get("updated_at")) ?? null });
    }
    const input = await request.json();
    if (!(await this.allow(String(input.address ?? "unknown")))) return json(429, { error: "too_many_attempts" });
    const who = this.who(String(input.hash ?? ""));
    if (who === "unconfigured") return json(403, { error: "setup_required" });
    if (who === "wrong") return json(403, { error: "secret_mismatch" });
    if (path === "/reset") {
      await this.state.storage.delete(["origin", "updated_at"]);
      return json(200, { ok: true });
    }
    if (typeof input.origin !== "string" || input.origin.length > 200 || !QUICK_RE.test(input.origin)) return json(400, { error: "origin_not_allowed" });
    await this.state.storage.put({ origin: input.origin, updated_at: Date.now() });
    return json(200, { ok: true });
  }
}

const book = (env) => env.BOOK.get(env.BOOK.idFromName("book"));
const hits = new Map();
const registerHits = new Map();
let memo = null;

/** Per-address limit kept in this isolate (no Durable Object touched). False when over the limit. */
function allowed(map, ip, now, limit) {
  if (map.size >= 2000) map.clear();
  const w = map.get(ip);
  if (!w || now - w.start >= 60_000) {
    map.set(ip, { start: now, count: 1 });
    return true;
  }
  w.count += 1;
  return w.count <= limit;
}

async function hmacHex(keyText, message) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(keyText), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** `{ proof }` for a valid `?nonce=`, only when this Worker has its setup value. */
async function proofFor(env, url) {
  const nonce = url.searchParams.get("nonce") ?? "";
  const setup = (env.SETUP_SECRET_SHA256 ?? "").trim().toLowerCase();
  if (!setup || !/^[0-9a-f]{16,64}$/i.test(nonce)) return {};
  return { proof: await hmacHex(setup, nonce) };
}

async function currentOrigin(env, now) {
  if (!memo || now - memo.at >= MEMO_MS) {
    const res = await book(env).fetch("https://book/origin");
    memo = { at: now, origin: (await res.json()).origin };
  }
  return memo.origin;
}

async function linkRoute(request, env, name) {
  if (name === "health") {
    if (request.method !== "GET") return json(405, { error: "method_not_allowed" });
    const state = await (await book(env).fetch("https://book/origin")).json();
    return json(200, { linked: Boolean(state.origin), updated_at: state.origin ? state.updated_at : null });
  }
  if (name !== "register" && name !== "reset") return json(404, { error: "not_found" });
  if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
  // Cheap refusals first: no Durable Object is touched for a flood or an oversized body.
  if (!allowed(registerHits, request.headers.get("cf-connecting-ip") ?? "unknown", Date.now(), REGISTER_PER_MINUTE)) return json(429, { error: "too_many_attempts" }, { "retry-after": "60" });
  const declared = Number.parseInt(request.headers.get("content-length") ?? "0", 10);
  if (declared > MAX_BODY) return json(413, { error: "too_large" });
  const token = bearer(request.headers.get("authorization"));
  if (!token) return json(401, { error: "secret_required" });
  let origin = null;
  if (name === "register") {
    try {
      const text = await request.text();
      if (text.length <= MAX_BODY) origin = JSON.parse(text).origin;
    } catch {
      origin = null;
    }
  }
  const res = await book(env).fetch(`https://book/${name}`, {
    method: "POST",
    body: JSON.stringify({ hash: await sha256Hex(token), origin, address: request.headers.get("cf-connecting-ip") ?? "unknown" }),
  });
  if (res.status === 200) memo = null;
  return json(res.status, await res.json());
}

async function whereRoute(request, env, url) {
  if (request.method !== "GET" && request.method !== "HEAD") return json(405, { error: "method_not_allowed" });
  const now = Date.now();
  if (!allowed(hits, request.headers.get("cf-connecting-ip") ?? "unknown", now, WHERE_PER_MINUTE)) return json(429, { ok: false }, { "retry-after": "30" });
  const proof = await proofFor(env, url);
  const origin = await currentOrigin(env, now);
  if (!origin || !QUICK_RE.test(origin)) return json(503, { ok: false, ...proof }, { "retry-after": "10" });
  // Never kept by a cache: a phone and the app must always see the address as it is now.
  return json(200, { ok: true, url: origin, ...proof });
}

const OLD = "This phone page is out of date. Update Potato Workspace on your PC, then open this link again.";
const OFFLINE =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<meta http-equiv="refresh" content="10"><title>PC offline</title></head>' +
  '<body style="font:16px system-ui;background:#161616;color:#e8e8e8;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0">' +
  '<main style="max-width:22rem;padding:1.5rem;text-align:center"><h1 style="font-size:1.1rem">Your PC is offline or Potato Workspace is closed.</h1>' +
  '<p style="color:#a0a0a0">This page will retry.</p></main></body></html>';
const offline = () => new Response(OFFLINE, { status: 503, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "retry-after": "10" } });

/** The phone page itself, fetched from the PC's current address (GET only, none of the client's headers). */
async function shell(request, env, url) {
  if (request.method !== "GET" && request.method !== "HEAD") return json(405, { error: "method_not_allowed" });
  const origin = await currentOrigin(env, Date.now());
  if (!origin || !QUICK_RE.test(origin)) return offline();
  const headers = new Headers();
  const accept = request.headers.get("accept");
  if (accept) headers.set("accept", accept);
  let upstream;
  try {
    upstream = await fetch(`${origin}${url.pathname}${url.search}`, { method: "GET", headers, redirect: "manual" });
  } catch {
    return offline();
  }
  if (upstream.status === 502 || upstream.status === 530) return offline();
  const out = new Response(upstream.body, upstream);
  const location = out.headers.get("location");
  // Only this very address: `https://x.trycloudflare.com.evil.com` is not it.
  if (location && (location === origin || location.startsWith(`${origin}/`))) out.headers.set("location", `${url.origin}${location.slice(origin.length)}`);
  out.headers.delete("set-cookie");
  out.headers.set("x-content-type-options", "nosniff");
  return out;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/_pm/")) {
      const path = url.pathname.slice(5);
      if (path === "where") return whereRoute(request, env, url);
      if (path === "health") {
        return request.method === "GET" ? json(200, { ok: true, protocol: "pm-relay/1", worker: NAME, features: ["stable-link"] }) : json(405, { error: "method_not_allowed" });
      }
      if (path.startsWith("link/")) return linkRoute(request, env, path.slice(5));
      return json(404, { error: "not_found" });
    }
    if (url.pathname === "/bridge" || url.pathname.startsWith("/bridge/") || url.pathname.startsWith("/__puppet_master_dev__")) {
      return json(410, { code: "BRIDGE_UNREACHABLE", error: OLD, message: OLD, reason: "not_proxied" }, { "retry-after": "3600", "clear-site-data": '"cache", "storage"' });
    }
    if ((request.headers.get("upgrade") ?? "").toLowerCase() === "websocket") return json(410, { error: "not_proxied" }, { "retry-after": "3600" });
    return shell(request, env, url);
  },
};
