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
const reset = (base, token = secret) => call(base, "/_pm/link/reset", { method: "POST", headers: { authorization: `Bearer ${token}` } });
test("before anything is registered: health says unlinked and nothing is forwarded (the relay answers)", async () => {
  const health = await (await call(MAIN, "/_pm/link/health")).json();
  assert.deepEqual(health, { linked: false, updated_at: null });
  assert.equal((await call(MAIN, "/hello")).status, 404);
  assert.equal((await call(MAIN, "/")).status, 200, "the relay front page");
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

test("the Worker is not a proxy any more: the phone API, bodies, event streams and sockets are refused and never reach the PC", async () => {
  const before = pc.seen.length;
  // an older phone page reads a 502 BRIDGE_UNREACHABLE and shows its message: the person is told what to do
  for (const path of ["/bridge/health", "/bridge/panes", "/bridge"]) {
    const old = await call(MAIN, path);
    assert.equal(old.status, 502, path);
    const body = await old.json();
    assert.equal(body.code, "BRIDGE_UNREACHABLE");
    assert.match(body.message, /Update Potato Workspace on your PC/);
  }
  assert.equal((await call(MAIN, "/echo", { method: "POST", body: "x" })).status, 405);
  assert.equal((await call(MAIN, "/echo", { method: "PUT", body: "x" })).status, 405);
  assert.equal((await call(MAIN, "/__puppet_master_dev__.json")).status, 502);
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

test("reset: needs the secret, then the link and the secret are cleared", async () => {
  assert.equal((await reset(MAIN, "not-the-secret")).status, 403);
  assert.equal((await call(MAIN, "/hello")).status, 200, "a wrong reset changes nothing");
  assert.equal((await reset(MAIN)).status, 200);
  assert.deepEqual(await (await call(MAIN, "/_pm/link/health")).json(), { linked: false, updated_at: null });
  assert.equal((await call(MAIN, "/hello")).status, 404);
  // a new secret may claim it again
  const other = randomBytes(32).toString("base64url");
  assert.equal((await register(MAIN, pc.origin, other)).status, 200);
  assert.equal((await register(MAIN, pc.origin, secret)).status, 403);
  assert.equal((await reset(MAIN, other)).status, 200);
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
  assert.equal((await call(STRICT, "/hello")).status, 200);
});
