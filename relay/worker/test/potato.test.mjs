// What only the merged Potato Worker does: it advertises its features, the relay and the stable link live side
// by side without touching each other, and invite links burn on first claim. Run with `npm run test:worker`
// (scripts/run-tests.mjs starts the Workers). Nothing here touches Cloudflare.
//   PM_RELAY_TEST_URL   TEST_HOOKS=1, loopback origins allowed, high limits
//   PM_RELAY_STRICT_URL as deployed
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { startFakeOrigin } from "./fake-origin.mjs";
import { client, key, registration } from "./proto.mjs";

const HOOKS = process.env.PM_RELAY_TEST_URL;
const STRICT = process.env.PM_RELAY_STRICT_URL;
assert.ok(HOOKS && STRICT, "set PM_RELAY_TEST_URL and PM_RELAY_STRICT_URL (npm run test:worker does)");

const root = key(11);
const device = key(12);
const stranger = key(13);
const CODE = /^[2-9A-HJKMNP-TV-Z]{16}$/;
const DAY = 24 * 3600 * 1000;

async function newTeam(base) {
  const api = client(base);
  const reg = registration(root, device, randomBytes(8));
  const res = await api.call("POST", "/v1/teams", { body: reg });
  assert.equal(res.status, 201, res.text);
  return { api, team: reg.team };
}

const makeInvite = (api, team, body, who = device) => api.call("POST", `/v1/teams/${team}/invite-links`, { body, device: who });
const raw = (base, path, init = {}) => fetch(`${base}${path}`, { redirect: "manual", ...init });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------------------------ features

test("health advertises what this Worker can do, on both health routes", async () => {
  for (const path of ["/v1/health", "/_pm/health"]) {
    const res = await raw(STRICT, path);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.protocol, "pm-relay/1");
    assert.equal(body.worker, "potato-worker/1");
    assert.deepEqual([...body.features].sort(), ["invites", "rooms", "stable-link", "team"]);
  }
  assert.equal((await raw(STRICT, "/_pm/health", { method: "POST" })).status, 405);
});

test("health shows no address, secret or count", async () => {
  const text = await (await raw(STRICT, "/_pm/health")).text();
  assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ["features", "ok", "protocol", "worker"]);
});

// ------------------------------------------------------------------ relay and link side by side

test("a linked PC does not take over the relay's routes, and a link secret is never forwarded or accepted by them", async () => {
  const pc = await startFakeOrigin();
  const secret = randomBytes(32).toString("base64url");
  try {
    const reg = await raw(HOOKS, "/_pm/link/register", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ origin: pc.origin }),
    });
    assert.equal(reg.status, 200);
    const before = pc.seen.length;
    assert.equal((await raw(HOOKS, "/v1/health")).status, 200);
    assert.equal((await raw(HOOKS, "/v1/nothing")).status, 404);
    assert.equal((await raw(HOOKS, `/join/${"A".repeat(16)}`)).status, 410);
    assert.equal(pc.seen.length, before, "nothing of the relay or invite side reached the PC");
    // anything else is the phone's
    assert.equal((await raw(HOOKS, "/hello")).status, 200);
    assert.ok(pc.seen.length > before);
    // a bearer secret on a relay route is refused as an unsigned request and goes nowhere
    const sent = pc.seen.length;
    const wrong = await raw(HOOKS, `/v1/teams/${"0".repeat(26)}/envelopes`, { headers: { authorization: `Bearer ${secret}` } });
    assert.equal(wrong.status, 401);
    assert.equal(pc.seen.length, sent);
    // the team side keeps working while linked
    const { api, team } = await newTeam(HOOKS);
    assert.equal((await api.call("GET", `/v1/teams/${team}/envelopes?after=0`, { device })).status, 200);
  } finally {
    await raw(HOOKS, "/_pm/link/reset", { method: "POST", headers: { authorization: `Bearer ${secret}` } });
    await pc.close();
  }
});

// ----------------------------------------------------------------------------------- invites

test("an invite link: made by a team device, peeked without burning, claimed once", async () => {
  const { api, team } = await newTeam(HOOKS);
  const payload = JSON.stringify({ link: "pm://team/join?v=1&t=x", code: "ABCD-EFGH" });
  const made = await makeInvite(api, team, { payload, team_name: "Design <b>crew</b>", inviter: "Ren", ttl_ms: 3_600_000 });
  assert.equal(made.status, 201, made.text);
  assert.match(made.json.code, CODE);
  assert.ok(made.json.expires_at_ms > Date.now() && made.json.expires_at_ms <= Date.now() + 3_600_000);
  const code = made.json.code;

  // peek: shows who and what, never the payload, and can be done again and again
  for (let i = 0; i < 3; i += 1) {
    const peek = await api.call("GET", `/v1/invites/${code}`);
    assert.equal(peek.status, 200);
    assert.equal(peek.json.state, "open");
    assert.equal(peek.json.team_name, "Design b crew /b");
    assert.equal(peek.json.inviter, "Ren");
    assert.ok(!peek.text.includes("ABCD-EFGH") && !("payload" in peek.json));
  }
  // a GET (a link preview) on the join page does not burn it either
  const page = await raw(HOOKS, `/join/${code}`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, new RegExp(`potato-workspace://join/${code}\\?w=`));
  assert.match(html, /Open the app/);
  assert.match(html, /Download Potato Workspace/);
  assert.ok(!html.includes("<b>"), "names are cleaned");
  assert.ok(!html.includes("ABCD-EFGH"), "the page never carries the payload");
  assert.match(page.headers.get("content-security-policy"), /default-src 'none'/);
  assert.equal((await api.call("GET", `/v1/invites/${code}`)).status, 200, "still open after the page");

  // claim: the first gets the payload, the second finds it used
  const first = await api.call("POST", `/v1/invites/${code}/claim`);
  assert.equal(first.status, 200);
  assert.equal(first.json.state, "claimed");
  assert.equal(first.json.payload, payload);
  const second = await api.call("POST", `/v1/invites/${code}/claim`);
  assert.equal(second.status, 410);
  assert.deepEqual(second.json, { state: "used" });
  assert.equal((await api.call("GET", `/v1/invites/${code}`)).status, 410);
  const used = await raw(HOOKS, `/join/${code}`);
  assert.equal(used.status, 410);
  assert.match(await used.text(), /already used/);
});

test("two claims at the same moment: exactly one wins", async () => {
  const { api, team } = await newTeam(HOOKS);
  const made = await makeInvite(api, team, { payload: "{}", team_name: "T", inviter: "I" });
  const results = await Promise.all(Array.from({ length: 8 }, () => api.call("POST", `/v1/invites/${made.json.code}/claim`)));
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(results.filter((r) => r.status === 410).length, 7);
});

test("an invite expires: 24 hours at most and by default, and an expired one cannot be claimed", async () => {
  const { api, team } = await newTeam(HOOKS);
  const long = await makeInvite(api, team, { payload: "{}", team_name: "T", inviter: "I", ttl_ms: 90 * DAY });
  assert.ok(long.json.expires_at_ms <= Date.now() + DAY + 1000, "capped at 24 hours");
  const dflt = await makeInvite(api, team, { payload: "{}", team_name: "T", inviter: "I" });
  assert.ok(dflt.json.expires_at_ms > Date.now() + DAY - 60_000, "24 hours by default");
  // The test hooks allow a very short life, so the real expiry can be seen.
  const short = await makeInvite(api, team, { payload: "{}", team_name: "T", inviter: "I", ttl_ms: 300 });
  assert.equal((await api.call("GET", `/v1/invites/${short.json.code}`)).status, 200);
  await sleep(600);
  const peek = await api.call("GET", `/v1/invites/${short.json.code}`);
  assert.equal(peek.status, 410);
  assert.deepEqual(peek.json, { state: "expired" });
  assert.equal((await api.call("POST", `/v1/invites/${short.json.code}/claim`)).status, 410);
  const page = await raw(HOOKS, `/join/${short.json.code}`);
  assert.equal(page.status, 410);
  assert.match(await page.text(), /ran out/);
});

test("as deployed an invite lasts at least a minute (no test hook)", async () => {
  const { api, team } = await newTeam(STRICT);
  const made = await makeInvite(api, team, { payload: "{}", team_name: "S", inviter: "R", ttl_ms: 1 });
  assert.ok(made.json.expires_at_ms >= Date.now() + 50_000);
  assert.equal((await api.call("POST", `/v1/invites/${made.json.code}/claim`)).status, 200);
  assert.equal((await raw(STRICT, `/v1/_test/${team}/dump`)).status, 404, "no test hooks");
});

test("only a device on the team can make an invite; junk bodies and codes are refused", async () => {
  const { api, team } = await newTeam(HOOKS);
  assert.equal((await api.call("POST", `/v1/teams/${team}/invite-links`, { body: { payload: "x" } })).status, 401, "unsigned");
  assert.equal((await makeInvite(api, team, { payload: "x" }, stranger)).status, 403, "not on the team");
  assert.equal((await makeInvite(api, team, { payload: "" })).status, 400);
  assert.equal((await makeInvite(api, team, { payload: 5 })).status, 400);
  assert.equal((await makeInvite(api, team, "not json")).status, 400);
  assert.equal((await makeInvite(api, team, { payload: "x".repeat(5000) })).status, 400);
  assert.equal((await makeInvite(api, "0".repeat(26), { payload: "x" })).status, 404, "unknown team");
  assert.equal((await api.call("GET", "/v1/invites/short")).status, 404);
  assert.equal((await api.call("GET", `/v1/invites/${"2".repeat(16)}`)).status, 404, "never made");
  assert.equal((await api.call("POST", `/v1/invites/${"2".repeat(16)}/claim`)).status, 404);
  assert.equal((await api.call("DELETE", `/v1/invites/${"2".repeat(16)}`)).status, 405);
  assert.equal((await api.call("GET", `/v1/invites/${"2".repeat(16)}/claim`)).status, 405, "a GET never claims");
  assert.equal((await raw(HOOKS, "/join/not-a-code")).status, 410);
});
