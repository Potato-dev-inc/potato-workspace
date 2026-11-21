// Unit tests for the pure parts of scripts/usage-check.mjs. Fabricated rows only; no network, no account.
import assert from "node:assert/strict";
import { test } from "node:test";
import { bar, isRejectedLogin, readTomlString, summarize, verdict } from "../scripts/usage-check.mjs";

const NOW = Date.parse("2026-11-19T12:00:00.000Z");
const HOUR = 3_600_000;

const hourRow = (hoursAgo, { colo = "LHR", code = 200, outcome = "ok", requests = 100, errors = 0 } = {}) => ({
  dimensions: { datetimeHour: new Date(NOW - hoursAgo * HOUR).toISOString(), coloCode: colo, httpResponseStatus: code, status: outcome },
  sum: { requests, errors, subrequests: 0 },
});

const fiveRow = (minutesAgo, { code = 200, requests = 10, colo = "LHR" } = {}) => ({
  dimensions: {
    datetimeFiveMinutes: new Date(NOW - minutesAgo * 60_000).toISOString(),
    coloCode: colo,
    httpResponseStatus: code,
    status: "ok",
  },
  sum: { requests, errors: 0, subrequests: 0 },
});

test("summarize totals the last 24 hours and the window", () => {
  const hourRows = [hourRow(1, { requests: 5000 }), hourRow(5, { requests: 3000 }), hourRow(30, { requests: 9999 })];
  const s = summarize({ hourRows, fiveRows: [], hours: 6, now: NOW });
  assert.equal(s.day.requests, 8000, "the 30-hour-old row is outside the day");
  assert.equal(s.day.limit, 100_000);
  assert.equal(s.day.percent, 8);
  assert.equal(s.window.requests, 8000, "6-hour window keeps the 1 h and 5 h rows only");
});

test("summarize ranks busiest hours, status codes and colos", () => {
  const hourRows = [
    hourRow(2, { requests: 100, code: 200, colo: "LHR" }),
    hourRow(2, { requests: 50, code: 410, colo: "AMS" }),
    hourRow(4, { requests: 700, code: 200, colo: "LHR" }),
  ];
  const s = summarize({ hourRows, fiveRows: [], hours: 24, now: NOW });
  assert.equal(s.busiestHours[0].requests, 700, "the 4-hours-ago hour is the busiest");
  assert.equal(s.busiestHours[1].requests, 150, "two rows in the same hour are added together");
  assert.deepEqual(
    s.statuses.map((x) => [x.code, x.requests]),
    [
      [200, 800],
      [410, 50],
    ],
  );
  assert.equal(s.colos[0].colo, "LHR");
});

test("summarize works out the last hour's failure share and the latest 5-minute rate", () => {
  const fiveRows = [
    fiveRow(2, { code: 200, requests: 10 }),
    fiveRow(7, { code: 503, requests: 90 }),
    fiveRow(40, { code: 200, requests: 500 }),
  ];
  const s = summarize({ hourRows: [], fiveRows, hours: 24, now: NOW });
  assert.equal(s.lastHour.requests, 600, "the 40-minute-old row is inside the hour, so it counts");
  assert.equal(s.lastHour.nonOk, 90);
  assert.equal(s.lastHour.nonOkShare, 0.15);
  assert.equal(s.lastFiveMinutes.requests, 10, "the newest bucket is the 2-minutes-ago one");
  assert.equal(s.lastFiveMinutes.perSecond, 10 / 300);
});

test("verdict is OK for quiet traffic", () => {
  const s = summarize({
    hourRows: [hourRow(1, { requests: 1000 })],
    fiveRows: [fiveRow(2, { requests: 30 }), fiveRow(20, { requests: 40 })],
    hours: 24,
    now: NOW,
  });
  const v = verdict(s);
  assert.equal(v.level, "OK");
  assert.deepEqual(v.reasons, []);
});

test("verdict is STORM when most of the last hour fails and the rate is high", () => {
  const s = summarize({
    hourRows: [hourRow(1, { requests: 90_000, code: 410 })],
    fiveRows: [fiveRow(1, { code: 410, requests: 2000 }), fiveRow(2, { code: 200, requests: 100 })],
    hours: 24,
    now: NOW,
  });
  const v = verdict(s);
  assert.equal(v.level, "STORM");
  assert.match(v.nextStep, /old phone page or an old app/);
  assert.ok(v.reasons.some((r) => /failed/.test(r)));
  assert.ok(v.reasons.some((r) => /per second/.test(r)));
});

test("verdict is WATCH when only the failure share is high, and when the rate alone is high", () => {
  const failingSlow = summarize({ hourRows: [], fiveRows: [fiveRow(3, { code: 500, requests: 60 })], hours: 24, now: NOW });
  assert.equal(verdict(failingSlow).level, "WATCH");

  const fastOk = summarize({ hourRows: [], fiveRows: [fiveRow(3, { code: 200, requests: 3000 })], hours: 24, now: NOW });
  assert.equal(verdict(fastOk).level, "WATCH");
});

test("verdict ignores a bad share from only a handful of requests", () => {
  const s = summarize({ hourRows: [], fiveRows: [fiveRow(3, { code: 410, requests: 4 })], hours: 24, now: NOW });
  assert.equal(verdict(s).level, "OK");
});

test("verdict is WATCH when the day is at 80% of the free allowance", () => {
  const s = summarize({ hourRows: [hourRow(3, { requests: 85_000 })], fiveRows: [], hours: 24, now: NOW });
  assert.equal(verdict(s).level, "WATCH");
});

test("readTomlString reads the top-level name and ignores tables", () => {
  const toml = 'name = "pm-relay"\n\n[[durable_objects.bindings]]\nname = "TEAM"\n';
  assert.equal(readTomlString(toml, "name"), "pm-relay");
  assert.equal(readTomlString("oauth_token = 'abc'", "oauth_token"), "abc");
  assert.equal(readTomlString('[section]\noauth_token = "x"', "oauth_token"), undefined);
});

test("bar draws a fixed-width bar and clamps", () => {
  assert.equal(bar(50, 10), "[#####-----]");
  assert.equal(bar(250, 4), "[####]");
  assert.equal(bar(0, 4), "[----]");
});

test("isRejectedLogin spots an expired login from its status or Cloudflare error code", () => {
  assert.equal(isRejectedLogin(401, null), true);
  assert.equal(isRejectedLogin(403, { success: false, errors: [{ code: 9109, message: "Invalid access token" }] }), true);
  assert.equal(isRejectedLogin(200, { errors: [{ code: 10000, message: "Authentication error" }] }), true);
  assert.equal(isRejectedLogin(403, { errors: [{ code: 10001, message: "missing permission" }] }), false);
  assert.equal(isRejectedLogin(200, { data: {} }), false);
});
