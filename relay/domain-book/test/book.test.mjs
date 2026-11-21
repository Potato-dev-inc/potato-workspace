// The Address book Worker, run in plain Node with a fake Durable Object (no Cloudflare, no network).
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { beforeEach, test } from "node:test";
import worker, { Book } from "../worker.js";

const QUICK = "https://calm-river-1234.trycloudflare.com";
const secret = "s3cret-s3cret-s3cret";
const hashOf = (text) => createHash("sha256").update(text).digest("hex");
const SETUP = hashOf(secret);
let nextIp = 0;

function makeEnv(vars = { SETUP_SECRET_SHA256: SETUP }) {
  const data = new Map();
  const storage = {
    get: async (key) => data.get(key),
    put: async (a, b) => (typeof a === "string" ? data.set(a, b) : Object.entries(a).forEach(([k, v]) => data.set(k, v))),
    delete: async (keys) => [].concat(keys).forEach((k) => data.delete(k)),
  };
  const env = { ...vars, ip: `203.0.113.${(nextIp += 1)}`, doCalls: 0 };
  const object = new Book({ storage }, env);
  env.BOOK = {
    idFromName: (n) => n,
    get: () => ({
      fetch: (url, init) => {
        env.doCalls += 1;
        return object.fetch(new Request(url, init));
      },
    }),
  };
  return env;
}

const call = (env, path, init = {}) =>
  worker.fetch(new Request(`https://phone.example.com${path}`, { ...init, headers: { "cf-connecting-ip": env.ip, ...(init.headers ?? {}) } }), env);
const register = (env, origin, token = secret) =>
  call(env, "/_pm/link/register", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ origin }) });

let env;
beforeEach(() => {
  env = makeEnv();
});

test("health lists the stable-link feature (the app sends no secret to a name that does not)", async () => {
  const body = await (await call(env, "/_pm/health")).json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.features, ["stable-link"]);
  assert.equal((await call(env, "/_pm/health", { method: "POST" })).status, 405);
});

test("nothing registered: where says 503, link health says unlinked, the page is the offline page", async () => {
  assert.equal((await call(env, "/_pm/where")).status, 503);
  assert.deepEqual(await (await call(env, "/_pm/link/health")).json(), { linked: false, updated_at: null });
  const page = await call(env, "/");
  assert.equal(page.status, 503);
  assert.match(await page.text(), /Your PC is offline/);
});

test("register: needs a secret, refuses anything that is not a quick tunnel, then where answers it (never cached)", async () => {
  assert.equal((await call(env, "/_pm/link/register", { method: "POST", body: "{}" })).status, 401);
  for (const bad of ["https://evil.example.com", "http://x.trycloudflare.com", "https://x.trycloudflare.com.evil.com", "https://169.254.169.254", "", null]) {
    assert.equal((await register(env, bad)).status, 400, String(bad));
  }
  assert.equal((await call(env, "/_pm/link/register")).status, 405);
  assert.equal((await call(env, "/_pm/where")).status, 503, "a refused address did not link");
  assert.equal((await register(env, QUICK)).status, 200);
  const where = await call(env, "/_pm/where");
  assert.deepEqual(await where.json(), { ok: true, url: QUICK });
  assert.equal(where.headers.get("cache-control"), "no-store");
  assert.equal((await (await call(env, "/_pm/link/health")).json()).linked, true);
});

test("only the setup key may register; another one is 403 and cannot move the address", async () => {
  assert.equal((await register(env, QUICK)).status, 200);
  assert.equal((await register(env, "https://other-name-9.trycloudflare.com", "another-secret")).status, 403);
  assert.deepEqual(await (await call(env, "/_pm/where")).json(), { ok: true, url: QUICK });
  assert.equal((await register(env, "https://next-name-2.trycloudflare.com")).status, 200, "the right key may move it");
});

test("a Worker with no setup key is closed: nobody can claim it, and a reset does not open it", async () => {
  const bare = makeEnv({});
  const res = await register(bare, QUICK);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, "setup_required");
  assert.equal((await call(bare, "/_pm/where")).status, 503);
  assert.equal((await call(bare, "/_pm/link/reset", { method: "POST", headers: { authorization: `Bearer ${secret}` } })).status, 403);
  const blank = makeEnv({ SETUP_SECRET_SHA256: "   " });
  assert.equal((await register(blank, QUICK)).status, 403);
});

test("a reset forgets the address but never makes the Worker claimable by another key", async () => {
  await register(env, QUICK);
  assert.equal((await call(env, "/_pm/link/reset", { method: "POST", headers: { authorization: "Bearer nope" } })).status, 403);
  assert.equal((await call(env, "/_pm/link/reset", { method: "POST", headers: { authorization: `Bearer ${secret}` } })).status, 200);
  assert.equal((await call(env, "/_pm/where")).status, 503);
  assert.equal((await register(env, QUICK, "a-new-secret")).status, 403, "still pinned to the setup key");
  assert.equal((await register(env, QUICK)).status, 200);
});

test("where proves the Worker: HMAC of the nonce with the setup hash, on 200 and on 503, and nothing without a valid nonce", async () => {
  const nonce = "0123456789abcdef0123456789abcdef";
  const want = createHmac("sha256", SETUP).update(nonce).digest("hex");
  const unlinked = await call(env, `/_pm/where?nonce=${nonce}`);
  assert.equal(unlinked.status, 503);
  assert.deepEqual(await unlinked.json(), { ok: false, proof: want });
  await register(env, QUICK);
  assert.deepEqual(await (await call(env, `/_pm/where?nonce=${nonce}`)).json(), { ok: true, url: QUICK, proof: want });
  for (const bad of ["zz", "abc", "g".repeat(32), "a".repeat(65)]) assert.equal((await (await call(env, `/_pm/where?nonce=${bad}`)).json()).proof, undefined, bad);
  // a Worker that does not hold the setup value cannot make it
  assert.equal((await (await call(makeEnv({}), `/_pm/where?nonce=${nonce}`)).json()).proof, undefined);
});

test("too many tries from one address are refused (429) by the Durable Object", async () => {
  env = makeEnv({ SETUP_SECRET_SHA256: SETUP, RATE_LIMIT_PER_HOUR: "3" });
  const statuses = [];
  for (let i = 0; i < 4; i += 1) statuses.push((await register(env, QUICK, i === 0 ? secret : "wrong-guess")).status);
  assert.deepEqual(statuses, [200, 403, 403, 429]);
});

test("a flood is refused in the isolate before any Durable Object is touched; an oversized body is refused before it is read", async () => {
  env = makeEnv();
  let refused = 0;
  for (let i = 0; i < 30; i += 1) if ((await register(env, QUICK)).status === 429) refused += 1;
  assert.ok(refused >= 10, `refused ${refused}`);
  assert.ok(env.doCalls <= 20, `the object saw ${env.doCalls} of 30`);
  const big = makeEnv();
  const calls = big.doCalls;
  const res = await call(big, "/_pm/link/register", { method: "POST", headers: { authorization: `Bearer ${secret}`, "content-length": "5000" }, body: "x".repeat(10) });
  assert.equal(res.status, 413);
  assert.equal(big.doCalls, calls);
});

test("the phone API and sockets are never carried", async () => {
  await register(env, QUICK);
  for (const path of ["/bridge", "/bridge/health", "/__puppet_master_dev__/info"]) {
    const res = await call(env, path);
    assert.equal(res.status, 410, path);
    assert.equal((await res.json()).code, "BRIDGE_UNREACHABLE");
  }
  assert.equal((await call(env, "/", { headers: { upgrade: "websocket" } })).status, 410);
});

test("the phone page comes from the registered address; cookies are dropped; posts are refused", async () => {
  await register(env, QUICK);
  const seen = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), headers: Object.fromEntries(new Headers(init?.headers)) });
    return new Response("<html>phone</html>", { status: 200, headers: { "content-type": "text/html", "set-cookie": "a=b" } });
  };
  try {
    const page = await call(env, "/index.html?x=1", { headers: { accept: "text/html", authorization: "Bearer leak", cookie: "c=d" } });
    assert.equal(page.status, 200);
    assert.equal(await page.text(), "<html>phone</html>");
    assert.equal(page.headers.get("set-cookie"), null);
    assert.equal(seen[0].url, `${QUICK}/index.html?x=1`);
    assert.equal(seen[0].headers.accept, "text/html");
    assert.equal(seen[0].headers.authorization, undefined, "none of the phone's headers go to the PC");
    assert.equal(seen[0].headers.cookie, undefined);
    assert.equal((await call(env, "/", { method: "POST", body: "x" })).status, 405);
  } finally {
    globalThis.fetch = real;
  }
});

test("a redirect is rewritten only when it is exactly the registered address, never a longer look-alike name", async () => {
  await register(env, QUICK);
  const real = globalThis.fetch;
  const to = { "/a": `${QUICK}/there`, "/b": QUICK, "/c": `${QUICK}.evil.com/there`, "/d": `${QUICK}evil/there`, "/e": `${QUICK}@evil.com/x` };
  globalThis.fetch = async (url) => new Response(null, { status: 302, headers: { location: to[new URL(String(url)).pathname] } });
  try {
    assert.equal((await call(env, "/a")).headers.get("location"), "https://phone.example.com/there");
    assert.equal((await call(env, "/b")).headers.get("location"), "https://phone.example.com");
    for (const path of ["/c", "/d", "/e"]) assert.equal((await call(env, path)).headers.get("location"), to[path], `${path} is left alone, not turned into this name`);
  } finally {
    globalThis.fetch = real;
  }
});

test("a dead PC address gives the offline page, not an error from the PC", async () => {
  await register(env, QUICK);
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response("bad gateway", { status: 530 });
  try {
    assert.equal((await call(env, "/")).status, 503);
  } finally {
    globalThis.fetch = real;
  }
});
