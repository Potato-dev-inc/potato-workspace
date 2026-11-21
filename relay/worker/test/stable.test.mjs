// The stable phone link of the Potato Worker. Run with `npm run test:worker` (scripts/run-tests.mjs starts the Workers and sets the variables below).
// The tests run in order: the main Worker keeps its link between tests, like a real one.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { startFakeOrigin } from "./fake-origin.mjs";

const MAIN = process.env.PM_LINK_URL;
const STRICT = process.env.PM_LINK_STRICT_URL;
const SETUP = process.env.PM_LINK_SETUP_SECRET;
assert.ok(MAIN && STRICT && SETUP, "run `npm test`: it starts the Workers and sets PM_LINK_URL, PM_LINK_STRICT_URL, PM_LINK_SETUP_SECRET");

const secret = randomBytes(32).toString("base64url");
let pc;

before(async () => {
  pc = await startFakeOrigin();
});
after(async () => {
  await pc.close();
});

const call = (base, path, init = {}) => fetch(`${base}${path}`, { redirect: "manual", ...init });
const register = (base, origin, token = secret) =>
  call(base, "/_pm/link/register", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ origin }),
  });
// A reset is a rotate: it must carry the new secret (the same one is fine when only the link is to be cleared).
const reset = (base, token = secret, next = token) =>
  call(base, "/_pm/link/reset", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(next === null ? {} : { new_secret: next }),
  });
test("before anything is registered: health says unlinked and nothing is forwarded (the relay answers)", async () => {
  const health = await (await call(MAIN, "/_pm/link/health")).json();
  assert.deepEqual(health, { linked: false, updated_at: null });
  assert.equal((await call(MAIN, "/hello")).status, 404);
  assert.equal((await call(MAIN, "/")).status, 200, "the relay front page");
});

test("reset on an unclaimed Worker claims it with the new secret (the same claim register would make), and nobody else can after that", async () => {
  assert.equal((await reset(MAIN, secret, secret)).status, 200);
  assert.equal((await register(MAIN, "https://evil.example.com", randomBytes(32).toString("base64url"))).status, 403, "a stranger is late");
  assert.deepEqual(await (await call(MAIN, "/_pm/link/health")).json(), { linked: false, updated_at: null });
});

test("the offline page needs no external asset and retries by itself", async () => {
  const html = (await import("node:fs")).readFileSync(new URL("../src/offline.ts", import.meta.url), "utf8");
  assert.match(html, /Your PC is offline or Potato Workspace is closed\./);
  assert.match(html, /This page will retry\./);
  assert.match(html, /http-equiv="refresh" content="10"/);
  assert.doesNotMatch(html, /https?:\/\//, "no external assets");
});

test("register: no secret is 401, a bad origin is 400 and does not claim the Worker", async () => {
  const none = await call(MAIN, "/_pm/link/register", { method: "POST", body: JSON.stringify({ origin: pc.origin }) });
  assert.equal(none.status, 401);
  for (const origin of ["https://evil.example.com", "http://example.com", "https://x.trycloudflare.com.evil.com", "https://169.254.169.254", "", null]) {
    const res = await register(MAIN, origin);
    assert.equal(res.status, 400, `origin ${origin}`);
  }
  assert.equal((await call(MAIN, "/_pm/link/register")).status, 405, "GET is not allowed");
  assert.equal((await call(MAIN, "/_pm/link/nothing", { method: "POST" })).status, 404);
  // still unclaimed: a different secret can still be the first
  assert.deepEqual(await (await call(MAIN, "/_pm/link/health")).json(), { linked: false, updated_at: null });
});

test("the shipped default origin rule accepts quick-tunnel names and nothing else", () => {
  const source = readFileSync(new URL("../src/stable.ts", import.meta.url), "utf8");
  const rule = new RegExp(JSON.parse(/DEFAULT_ORIGIN_RE = (".*");/.exec(source)[1]));
  assert.ok(rule.test("https://rapid-able-wolf-3.trycloudflare.com"));
  for (const bad of ["http://a.trycloudflare.com", "https://a.trycloudflare.com/", "https://a.trycloudflare.com.evil.io", "https://a.b.trycloudflare.com", "https://A.trycloudflare.com"]) {
    assert.ok(!rule.test(bad), bad);
  }
});

test("register: the first secret wins (trust on first use), a later wrong secret is 403", async () => {
  const first = await register(MAIN, pc.origin);
  assert.equal(first.status, 200);
  const wrong = await register(MAIN, pc.origin, randomBytes(32).toString("base64url"));
  assert.equal(wrong.status, 403);
  assert.equal((await wrong.json()).error, "secret_mismatch");
  assert.equal((await register(MAIN, pc.origin)).status, 200, "the right secret may register again");
});

test("health tells linked and a time, and never the address or the secret", async () => {
  const text = await (await call(MAIN, "/_pm/link/health")).text();
  const health = JSON.parse(text);
  assert.equal(health.linked, true);
  assert.ok(Number.isFinite(health.updated_at));
  assert.deepEqual(Object.keys(health).sort(), ["linked", "updated_at"]);
  assert.ok(!text.includes("127.0.0.1") && !text.includes(secret));
});

test("where: linked gives the tunnel address as JSON, cacheable for a short time, and asks the PC nothing", async () => {
  const before = pc.seen.length;
  const res = await call(MAIN, "/_pm/where");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/json");
  assert.match(res.headers.get("cache-control"), /max-age=15/);
  assert.deepEqual(await res.json(), { ok: true, url: pc.origin });
  assert.equal(pc.seen.length, before, "no subrequest to the PC");
  assert.equal((await call(MAIN, "/_pm/where", { method: "POST" })).status, 405);
});

test("where: a new registration is visible at once, and the answer never holds the secret", async () => {
  const other = await startFakeOrigin();
  try {
    assert.equal((await register(MAIN, other.origin)).status, 200);
    const text = await (await call(MAIN, "/_pm/where")).text();
    assert.deepEqual(JSON.parse(text), { ok: true, url: other.origin });
    assert.ok(!text.includes(secret));
  } finally {
    assert.equal((await register(MAIN, pc.origin)).status, 200);
    await other.close();
  }
});

test("where: a quick-tunnel rule violation is never handed out (SSRF): bad origins cannot be registered, so where never shows them", async () => {
  for (const origin of ["https://169.254.169.254", "https://evil.example.com", "https://a.trycloudflare.com.evil.io"]) {
    assert.equal((await register(MAIN, origin)).status, 400, origin);
  }
  assert.equal((await (await call(MAIN, "/_pm/where")).json()).url, pc.origin);
});

test("shell: GET of the phone page is served from the PC, with the client's headers kept off", async () => {
  const base = new URL(MAIN);
  const res = await call(MAIN, "/hello?a=1&b=two", { headers: { cookie: "s=1", authorization: "Bearer x", "x-forwarded-host": "spoofed.example" } });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "hello ?a=1&b=two");
  const seen = pc.seen.findLast((r) => r.path.startsWith("/hello"));
  assert.equal(seen.method, "GET");
  assert.equal(seen.headers.cookie, undefined);
  assert.equal(seen.headers.authorization, undefined);
  assert.notEqual(seen.headers["x-forwarded-host"], "spoofed.example");
  assert.ok(!(res.headers.get("cache-control") ?? "").includes("s-maxage"), "a plain-text answer is not an edge-cached page file");
  assert.ok(base.host);
});

test("shell caching: hashed asset files get the Worker's own cache header; index.html, sw.js and deep links stay uncached", async () => {
  const asset = await call(MAIN, "/assets/app-abc123.js");
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get("cache-control"), "public, max-age=3600, s-maxage=600", "the PC's no-store is replaced for page files");
  for (const path of ["/index.html", "/sw.js", "/deep/link"]) {
    const res = await call(MAIN, path);
    assert.equal(res.status, 200, path);
    assert.equal(res.headers.get("cache-control"), "no-store", `${path}: the PC's own header stays`);
  }
  const before = pc.seen.length;
  await call(MAIN, "/index.html");
  await call(MAIN, "/index.html");
  assert.equal(pc.seen.length - before, 2, "index.html is asked of the PC every time");
});

test("shell cache hit: a cached page file needs neither the address lookup nor the PC, and the query string is not part of the key", async () => {
  const path = "/assets/app-abc123.js";
  const first = await call(MAIN, path);
  assert.equal(first.status, 200);
  await first.text();
  const before = pc.seen.length;
  // same file, other query strings: all answered from the edge cache, the PC is not asked
  for (const q of ["", "?a=1", "?a=2&b=3"]) {
    const res = await call(MAIN, path + q);
    assert.equal(res.status, 200, q);
    assert.equal(res.headers.get("cache-control"), "public, max-age=3600, s-maxage=600", q);
    await res.text();
  }
  assert.equal(pc.seen.length, before, "no request reached the PC for cached page files");
});

test("unlinked: nothing is served from the edge cache, even a page file cached while linked", async () => {
  const path = "/assets/app-abc123.js";
  assert.equal((await call(MAIN, path)).status, 200, "cached while linked");
  assert.equal((await reset(MAIN)).status, 200);
  try {
    const before = pc.seen.length;
    assert.equal((await call(MAIN, path)).status, 404, "unlinked: a cached page file is not served; the relay's own 404");
    assert.equal((await call(MAIN, path + "?v=2")).status, 404, "unlinked: no query variant either");
    assert.equal((await call(MAIN, "/assets/never-cached-1.js")).status, 404, "unlinked: an uncached file falls to the relay's own 404");
    assert.equal((await call(MAIN, "/sw.js")).status, 404, "sw.js is never served from the cache");
    assert.equal((await call(MAIN, "/index.html")).status, 404, "index.html is never served from the cache");
    assert.equal(pc.seen.length, before, "unlinked: the PC is not asked either");
  } finally {
    assert.equal((await register(MAIN, pc.origin)).status, 200);
  }
  // linked again: the page and sw.js come from the PC every time
  const mark = pc.seen.length;
  assert.equal((await call(MAIN, "/sw.js")).status, 200);
  assert.equal((await call(MAIN, "/sw.js")).status, 200);
  assert.equal(pc.seen.length - mark, 2);
});

test("tunnel change: a page file cached under tunnel A is never served once tunnel B is registered", async () => {
  const path = "/assets/tunnel-swap-1.js";
  const b = await startFakeOrigin("B");
  try {
    assert.equal((await register(MAIN, pc.origin)).status, 200);
    for (let i = 0; i < 2; i += 1) {
      const res = await call(MAIN, path);
      assert.equal(res.status, 200);
      assert.equal(await res.text(), 'console.log("A")');
    }
    assert.equal(pc.seen.filter((r) => r.path === path).length, 1, "A is asked once; the second load is a cache hit");
    // the registered tunnel changes: the same path must go to B (a miss) and never answer with A's cached file
    assert.equal((await register(MAIN, b.origin)).status, 200);
    const res = await call(MAIN, path);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'console.log("B")', "B's own file, not A's cached one");
    assert.equal(b.seen.filter((r) => r.path === path).length, 1, "B was asked: a cache miss");
    assert.equal(pc.seen.filter((r) => r.path === path).length, 1, "A was not asked again");
    // and B's answer is cached under B only: a second load is a hit on B, still without asking anyone
    assert.equal(await (await call(MAIN, path)).text(), 'console.log("B")');
    assert.equal(b.seen.filter((r) => r.path === path).length, 1);
  } finally {
    assert.equal((await register(MAIN, pc.origin)).status, 200);
    await b.close();
  }
});

test("page files: the query string never reaches the PC and never splits the cache; nosniff on misses and hits", async () => {
  const path = "/assets/query-collapse-1.js";
  const miss = await call(MAIN, path + "?v=1&x=abc");
  assert.equal(miss.status, 200);
  assert.equal(miss.headers.get("x-content-type-options"), "nosniff", "miss: nosniff");
  assert.equal(await miss.text(), 'console.log("A")');
  const asked = pc.seen.filter((r) => r.path.startsWith(path));
  assert.equal(asked.length, 1);
  assert.equal(asked[0].path, path, "the PC was asked for the bare path, not the query");
  const hit = await call(MAIN, path + "?v=2");
  assert.equal(hit.status, 200);
  assert.equal(hit.headers.get("x-content-type-options"), "nosniff", "hit: nosniff");
  assert.equal(hit.headers.get("cache-control"), "public, max-age=3600, s-maxage=600");
  await hit.text();
  assert.equal(pc.seen.filter((r) => r.path.startsWith(path)).length, 1, "query variants are hits: the PC is asked once");
  // a path that is not a page file keeps its query string on the PC fetch (the /hello test above relies on it)
  const plain = await call(MAIN, "/hello?keep=1");
  assert.equal(await plain.text(), "hello ?keep=1");
});

test("the Worker is not a proxy any more: the phone API, bodies, event streams and sockets are refused and never reach the PC", async () => {
  const before = pc.seen.length;
  // an older phone page reads a 410 BRIDGE_UNREACHABLE and shows its message: the person is told what to do
  for (const path of ["/bridge/health", "/bridge/panes", "/bridge"]) {
    const old = await call(MAIN, path);
    assert.equal(old.status, 410, path);
    assert.match(old.headers.get("clear-site-data") ?? "", /storage/);
    assert.equal(old.headers.get("retry-after"), "3600");
    const body = await old.json();
    assert.equal(body.code, "BRIDGE_UNREACHABLE");
    assert.match(body.message, /Update Potato Workspace on your PC/);
  }
  assert.equal((await call(MAIN, "/echo", { method: "POST", body: "x" })).status, 405);
  assert.equal((await call(MAIN, "/echo", { method: "PUT", body: "x" })).status, 405);
  assert.equal((await call(MAIN, "/__puppet_master_dev__.json")).status, 410);
  const failed = await new Promise((resolve) => {
    const ws = new WebSocket(MAIN.replace("http://", "ws://") + "/socket?x=1");
    const timer = setTimeout(() => resolve(false), 5000);
    ws.onopen = () => {
      clearTimeout(timer);
      ws.close();
      resolve(false);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      resolve(true);
    };
  });
  assert.ok(failed, "a WebSocket upgrade is not passed on");
  assert.equal(pc.seen.length, before, "nothing was forwarded");
});

test("offline: the PC answers 502, or is not reachable at all: 503 page (shell), 503 JSON (where)", async () => {
  const down = await call(MAIN, "/down");
  assert.equal(down.status, 503);
  assert.match(await down.text(), /offline or Potato Workspace is closed/);

  const closed = await startFakeOrigin();
  const dead = closed.origin;
  await closed.close();
  assert.equal((await register(MAIN, dead)).status, 200);
  const res = await call(MAIN, "/hello2");
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("retry-after"), "10");
  assert.match(await res.text(), /This page will retry/);
  // the PC comes back with a new address: the next request uses it at once
  assert.equal((await register(MAIN, pc.origin)).status, 200);
  assert.equal((await call(MAIN, "/hello")).status, 200);
});

test("the control routes are not forwarded and unknown /_pm paths are 404", async () => {
  const before = pc.seen.length;
  assert.equal((await call(MAIN, "/_pm/other")).status, 404);
  assert.equal(pc.seen.length, before);
});

test("reset: needs the secret, then the link is cleared and the secret is rotated in the same step", async () => {
  assert.equal((await reset(MAIN, "not-the-secret")).status, 403);
  assert.equal((await call(MAIN, "/hello")).status, 200, "a wrong reset changes nothing");
  const other = randomBytes(32).toString("base64url");
  assert.equal((await reset(MAIN, secret, other)).status, 200);
  assert.deepEqual(await (await call(MAIN, "/_pm/link/health")).json(), { linked: false, updated_at: null });
  assert.equal((await call(MAIN, "/hello")).status, 404);
  // the old secret is refused at once, and a stranger cannot claim the Worker in the unlinked moment
  assert.equal((await register(MAIN, pc.origin, secret)).status, 403, "old secret refused after rotate");
  assert.equal((await reset(MAIN, secret, secret)).status, 403, "old secret cannot rotate again");
  const stranger = randomBytes(32).toString("base64url");
  assert.equal((await register(MAIN, pc.origin, stranger)).status, 403, "a stranger cannot register after rotate");
  assert.equal((await reset(MAIN, stranger, stranger)).status, 403);
  assert.deepEqual(await (await call(MAIN, "/_pm/link/health")).json(), { linked: false, updated_at: null });
  // only the new secret registers
  assert.equal((await register(MAIN, pc.origin, other)).status, 200);
  assert.equal((await call(MAIN, "/hello")).status, 200);
  assert.equal((await reset(MAIN, other, secret)).status, 200, "rotate back so later tests keep their secret");
  assert.equal((await register(MAIN, pc.origin, secret)).status, 200);
});

test("reset without a usable new secret is refused (a plain reset would reopen first-come-first-served) and changes nothing", async () => {
  for (const next of [null, "", "short", "has space in it 0123456789", 12]) {
    assert.equal((await reset(MAIN, secret, next)).status, 400, String(next));
  }
  assert.equal((await call(MAIN, "/hello")).status, 200, "still linked");
  assert.equal((await register(MAIN, pc.origin, randomBytes(32).toString("base64url"))).status, 403, "still owned");
  assert.equal((await register(MAIN, pc.origin)).status, 200);
});

test("SETUP_SECRET_SHA256: only that secret can register, nobody can claim first", async () => {
  assert.equal((await register(STRICT, pc.origin, randomBytes(32).toString("base64url"))).status, 403);
  assert.equal((await call(STRICT, "/hello")).status, 404);
  assert.equal((await register(STRICT, pc.origin, SETUP)).status, 200);
  assert.equal((await call(STRICT, "/hello")).status, 200);
  assert.equal((await register(STRICT, "https://evil.example.com", SETUP)).status, 400);
});

test("where: rate limited per address (429) without touching the PC", async () => {
  const statuses = [];
  for (let i = 0; i < 80; i += 1) statuses.push((await call(STRICT, "/_pm/where")).status);
  assert.ok(statuses.includes(429), `no 429 in ${statuses}`);
  assert.ok(statuses.includes(200) || statuses.includes(503));
});

test("rate limit: more than 30 register/reset tries an hour from one address get 429", async () => {
  const wrong = randomBytes(32).toString("base64url");
  const statuses = [];
  for (let i = 0; i < 40; i += 1) statuses.push((await register(STRICT, pc.origin, wrong)).status);
  assert.ok(statuses.includes(429), `no 429 in ${statuses}`);
  assert.equal(statuses.indexOf(429) > 0, true);
  // while limited even the right secret is refused, and the link keeps working for the phone
  assert.equal((await register(STRICT, pc.origin, SETUP)).status, 429);
  assert.equal((await reset(STRICT, SETUP, SETUP)).status, 429, "reset is limited too");
  assert.equal((await call(STRICT, "/hello")).status, 200);
});
