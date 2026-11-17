// Far-away pairing boxes (src/pair.ts). Run with `npm run test:worker` (scripts/run-tests.mjs starts the Workers).
//   PM_PAIR_URL        a Worker with PAIR_OWNER set to the key `key(21)` and a small box cap (LIMIT_PAIR_MAX_OPEN=3)
//   PM_PAIR_OFF_URL    a Worker without PAIR_OWNER: the feature is off
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import { client, key } from "./proto.mjs";

const PAIR = process.env.PM_PAIR_URL;
const OFF = process.env.PM_PAIR_OFF_URL;
assert.ok(PAIR && OFF, "set PM_PAIR_URL and PM_PAIR_OFF_URL (npm run test:worker does)");

const owner = key(21);
const stranger = key(22);
const sha = (text) => createHash("sha256").update(text).digest("hex");
const tok = () => randomBytes(16).toString("base64url");
const api = client(PAIR);

/** A new box: its rid, the tokens, and the create call's answer. */
async function open({ by = owner, ttl_ms = 600_000, rid = randomBytes(32).toString("hex") } = {}) {
  const pair = tok();
  const host = tok();
  const made = await api.call("POST", "/v1/pair", { body: { rid, pair_hash: sha(pair), host_hash: sha(host), ttl_ms }, device: by });
  return { rid, pair, host, made };
}
const as = (who) => ({ ...(who.pair ? { "x-pm-pair": who.pair } : {}), ...(who.host ? { "x-pm-host": who.host } : {}), ...(who.claim ? { "x-pm-claim": who.claim } : {}) });
const post = (rid, who, from, n, ct) => api.call("POST", `/v1/pair/${rid}/msg`, { body: { from, n, ct }, headers: as(who) });
const poll = (rid, who, forDir, after = 0) => api.call("GET", `/v1/pair/${rid}/msg?for=${forDir}&after=${after}`, { headers: as(who) });
const claim = (rid, who) => api.call("POST", `/v1/pair/${rid}/claim`, { headers: as(who) });
const close = (b) => api.call("DELETE", `/v1/pair/${b.rid}`, { headers: as({ host: b.host }) });
const closed = async (b) => assert.equal((await close(b)).status, 204, "the host closes its box");

test("the feature is listed only when the owner key is set", async () => {
  const on = await (await fetch(`${PAIR}/v1/health`)).json();
  assert.ok(on.features.includes("pair"));
  const off = await (await fetch(`${OFF}/v1/health`)).json();
  assert.ok(!off.features.includes("pair"));
  assert.equal((await client(OFF).call("POST", "/v1/pair", { body: {}, device: owner })).status, 404, "off = unknown path");
});

test("a box is opened only by the owner's signature", async () => {
  const rid = randomBytes(32).toString("hex");
  const unsigned = await api.call("POST", "/v1/pair", { body: { rid, pair_hash: sha("a"), host_hash: sha("b") } });
  assert.equal(unsigned.status, 401);
  const wrong = await open({ by: stranger });
  assert.equal(wrong.made.status, 403, "a stranger with the Worker address cannot open boxes");
  const ok = await open();
  assert.equal(ok.made.status, 201, ok.made.text);
  assert.ok(ok.made.json.expires_at_ms <= Date.now() + 600_000);
  assert.equal((await open({ rid: ok.rid })).made.status, 409, "a rid is never reused");
  const bad = await api.call("POST", "/v1/pair", { body: { rid: "xyz", pair_hash: "no", host_hash: "no" }, device: owner });
  assert.equal(bad.status, 400);
  await closed(ok);
});

test("claim: the first joiner locks the box, the second is told it is used", async () => {
  const b = await open();
  assert.equal((await claim(b.rid, { pair: tok() })).status, 404, "a wrong token looks like no box");
  const [one, two] = await Promise.all([claim(b.rid, { pair: b.pair }), claim(b.rid, { pair: b.pair })]);
  assert.deepEqual([one.status, two.status].sort(), [200, 409], "two claims at the same moment give exactly one winner");
  const winner = one.status === 200 ? one : two;
  assert.match(winner.json.claim, /^[A-Za-z0-9_-]{22}$/);
  assert.equal((await claim(b.rid, { pair: b.pair })).json.error, "claimed");
  await closed(b);
});

test("messages travel both ways, in order, only to the right side", async () => {
  const b = await open();
  const c = (await claim(b.rid, { pair: b.pair })).json.claim;
  const joiner = { pair: b.pair, claim: c };
  const host = { host: b.host };
  assert.equal((await post(b.rid, joiner, "j", 0, "aGVsbG8")).status, 200);
  assert.equal((await post(b.rid, joiner, "j", 0, "dXA")).status, 409, "the same number twice is refused");
  assert.equal((await post(b.rid, host, "h", 0, "d2hhdA")).status, 200);
  const toHost = await poll(b.rid, host, "h");
  assert.deepEqual(toHost.json.msgs.map((m) => m.ct), ["aGVsbG8"]);
  assert.equal(toHost.json.claimed, true);
  const toJoiner = await poll(b.rid, joiner, "j");
  assert.deepEqual(toJoiner.json.msgs.map((m) => m.ct), ["d2hhdA"]);
  assert.equal((await poll(b.rid, host, "h", toHost.json.msgs[0].i)).json.msgs.length, 0, "after the position, nothing new");
  // the link alone cannot read the host's inbox, post as the host or delete the box
  assert.equal((await poll(b.rid, { pair: b.pair }, "h")).status, 404);
  assert.equal((await post(b.rid, { pair: b.pair }, "h", 5, "eA")).status, 404);
  assert.equal((await api.call("DELETE", `/v1/pair/${b.rid}`, { headers: as({ pair: b.pair }) })).status, 404);
  // and the host cannot read the joiner's inbox
  assert.equal((await poll(b.rid, host, "j")).status, 404);
  // a joiner without the claim token is refused
  assert.equal((await post(b.rid, { pair: b.pair }, "j", 9, "eA")).status, 404);
  await closed(b);
});

test("a message must be well formed and the box holds only so many", async () => {
  const b = await open();
  const host = { host: b.host };
  assert.equal((await post(b.rid, host, "h", 0, "not base64url!")).status, 400);
  assert.equal((await post(b.rid, host, "x", 0, "eA")).status, 400);
  assert.ok([400, 413].includes((await post(b.rid, host, "h", 0, "A".repeat(33 * 1024))).status), "too long");
  for (let n = 0; n < 40; n += 1) assert.equal((await post(b.rid, host, "h", n, "eA")).status, 200, `message ${n}`);
  assert.equal((await post(b.rid, host, "h", 40, "eA")).status, 429, "the box is full");
  await closed(b);
});

test("a box ends with the host's delete, and then looks like no box", async () => {
  const b = await open();
  assert.equal((await api.call("DELETE", `/v1/pair/${b.rid}`, { headers: as({ host: tok() }) })).status, 404);
  assert.equal((await close(b)).status, 204);
  assert.equal((await claim(b.rid, { pair: b.pair })).status, 404);
  assert.equal((await poll(b.rid, { host: b.host }, "h")).status, 404);
});

test("the shortest life is a minute, not a few milliseconds", async () => {
  const b = await open({ ttl_ms: 1 });
  assert.equal(b.made.status, 201);
  assert.ok(b.made.json.expires_at_ms - Date.now() >= 55_000);
  await closed(b);
});

test("a life must be a number between 1 ms and ten minutes", async () => {
  for (const ttl_ms of [0, -5, 600_001, "10", null]) {
    const b = await open({ ttl_ms });
    assert.equal(b.made.status, 400, `ttl ${ttl_ms}`);
  }
});

test("the cap on open boxes", async () => {
  const made = [];
  for (let i = 0; i < 10; i += 1) {
    const b = await open();
    made.push(b);
    if (b.made.status === 503) break;
  }
  assert.ok(made.some((b) => b.made.status === 503), "the Worker stops opening boxes when full");
  for (const b of made.filter((x) => x.made.status === 201)) await close(b);
  const again = await open();
  assert.equal(again.made.status, 201, "deleting gives the slots back");
  await closed(again);
});

test("unknown shapes and methods are plain refusals", async () => {
  assert.equal((await api.call("GET", "/v1/pair")).status, 405);
  assert.equal((await api.call("GET", "/v1/pair/nothing/msg")).status, 404);
  const rid = randomBytes(32).toString("hex");
  assert.equal((await api.call("PUT", `/v1/pair/${rid}/msg`)).status, 405);
  assert.equal((await api.call("GET", `/v1/pair/${rid}/msg?for=h`, { headers: as({ host: tok() }) })).status, 404);
});
