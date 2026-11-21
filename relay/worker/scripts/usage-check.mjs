#!/usr/bin/env node
// How many requests has the team relay Worker used, and is something retrying too much?
//
//   node scripts/usage-check.mjs                 last 24 hours, Worker name from wrangler.toml (pm-relay)
//   node scripts/usage-check.mjs pm-relay --hours 6
//   node scripts/usage-check.mjs --json          the same numbers as JSON (no token, account id masked)
//
// It reads only. It asks Cloudflare's GraphQL analytics for the Worker's request counts. Login comes from
// `npx wrangler login` (the OAuth token wrangler keeps on this computer), or from the environment:
// CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID. The token is never printed.
//
// Exit codes: 0 = OK or WATCH, 1 = STORM, 2 = not logged in or login rejected (401), 3 = the login may not
// read analytics (403), 4 = any other error (network, unexpected answer).
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const FREE_DAILY_REQUESTS = 100_000;
const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";
const ACCOUNTS_URL = "https://api.cloudflare.com/client/v4/accounts";
const DEFAULT_WORKER = "pm-relay";
const REJECTED = "Cloudflare rejected the login (it is expired or invalid). Run `npx wrangler login` again, then retry.";
const HOUR_MS = 3_600_000;
const MIN_SAMPLE = 20; // below this many requests in the last hour, a bad share proves nothing

export class UsageError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.exitCode = exitCode;
  }
}

// ---------- pure functions (unit tested) ----------

/** Turn GraphQL rows ({ dimensions, sum }) into flat rows. `timeKey` is datetimeHour or datetimeFiveMinutes. */
export function flattenRows(rows, timeKey) {
  return (rows || []).map((row) => {
    const d = row.dimensions || {};
    const s = row.sum || {};
    const at = Date.parse(d[timeKey]);
    return {
      at: Number.isNaN(at) ? null : at,
      colo: d.coloCode || "unknown",
      code: Number(d.httpResponseStatus ?? 0),
      outcome: d.status || "unknown",
      requests: Number(s.requests || 0),
      errors: Number(s.errors || 0),
    };
  });
}

const isOk = (code) => code >= 200 && code < 300;

/** Cloudflare says the token is bad: a 401, or a 403 with "Invalid access token" (code 9109), or GraphQL code 10000. */
export function isRejectedLogin(status, body) {
  if (status === 401) return true;
  const errors = [...(body?.errors || []), ...((body && body.success === false && body.errors) || [])];
  return errors.some((e) => e?.code === 9109 || e?.code === 10000 || /invalid access token|authentication error/i.test(e?.message || ""));
}

function groupSum(rows, keyOf) {
  const map = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    map.set(k, (map.get(k) || 0) + r.requests);
  }
  return map;
}

/**
 * Summarise the Worker's traffic.
 * @param {object} input
 * @param {object[]} input.hourRows   GraphQL rows grouped by datetimeHour (covers at least the last 24 h)
 * @param {object[]} input.fiveRows   GraphQL rows grouped by datetimeFiveMinutes (covers the last 60 min)
 * @param {number}   input.hours      the window the breakdowns cover (default 24)
 * @param {number}   input.now        ms timestamp of "now" (default Date.now())
 */
export function summarize({ hourRows = [], fiveRows = [], hours = 24, now = Date.now() } = {}) {
  const hourly = flattenRows(hourRows, "datetimeHour").filter((r) => r.at !== null);
  const fiveMin = flattenRows(fiveRows, "datetimeFiveMinutes").filter((r) => r.at !== null);
  const windowStart = now - hours * HOUR_MS;
  const dayStart = now - 24 * HOUR_MS;

  const inWindow = hourly.filter((r) => r.at >= windowStart && r.at <= now);
  const inDay = hourly.filter((r) => r.at >= dayStart && r.at <= now);
  const dayRequests = inDay.reduce((n, r) => n + r.requests, 0);
  const windowRequests = inWindow.reduce((n, r) => n + r.requests, 0);

  const busiestHours = [...groupSum(inWindow, (r) => r.at)]
    .map(([at, requests]) => ({ at: new Date(at).toISOString(), requests }))
    .sort((a, b) => b.requests - a.requests)
    .slice(0, 5);

  const statuses = [...groupSum(inWindow, (r) => r.code)]
    .map(([code, requests]) => ({ code, requests, share: windowRequests ? requests / windowRequests : 0 }))
    .sort((a, b) => b.requests - a.requests);

  const outcomes = [...groupSum(inWindow, (r) => r.outcome)]
    .map(([outcome, requests]) => ({ outcome, requests }))
    .sort((a, b) => b.requests - a.requests);

  const colos = [...groupSum(inWindow, (r) => r.colo)]
    .map(([colo, requests]) => ({ colo, requests, share: windowRequests ? requests / windowRequests : 0 }))
    .sort((a, b) => b.requests - a.requests)
    .slice(0, 5);

  const hourStart = now - HOUR_MS;
  const lastHour = fiveMin.filter((r) => r.at > hourStart && r.at <= now);
  const lastHourRequests = lastHour.reduce((n, r) => n + r.requests, 0);
  const lastHourNonOk = lastHour.filter((r) => !isOk(r.code)).reduce((n, r) => n + r.requests, 0);

  // Latest 5-minute bucket: the newest bucket that has started.
  const newest = fiveMin.filter((r) => r.at <= now).reduce((max, r) => (max === null || r.at > max ? r.at : max), null);
  const latestRequests = newest === null ? 0 : fiveMin.filter((r) => r.at === newest).reduce((n, r) => n + r.requests, 0);

  return {
    windowHours: hours,
    day: {
      requests: dayRequests,
      limit: FREE_DAILY_REQUESTS,
      percent: (dayRequests / FREE_DAILY_REQUESTS) * 100,
    },
    window: { requests: windowRequests, errors: inWindow.reduce((n, r) => n + r.errors, 0) },
    dayNonOkShare: dayRequests ? inDay.filter((r) => !isOk(r.code)).reduce((n, r) => n + r.requests, 0) / dayRequests : 0,
    busiestHours,
    statuses,
    outcomes,
    colos,
    lastHour: {
      requests: lastHourRequests,
      nonOk: lastHourNonOk,
      nonOkShare: lastHourRequests ? lastHourNonOk / lastHourRequests : 0,
    },
    lastFiveMinutes: {
      at: newest === null ? null : new Date(newest).toISOString(),
      requests: latestRequests,
      perSecond: latestRequests / 300,
    },
  };
}

/**
 * Decide OK / WATCH / STORM from a summary (see summarize).
 * STORM: most of the last hour failed AND the latest 5 minutes ran above 5 requests per second.
 * WATCH: either of those alone, or the last 24 h used 80% or more of the free daily allowance.
 */
export function verdict(summary) {
  const reasons = [];
  const { lastHour, lastFiveMinutes, day } = summary;
  const failing = lastHour.requests >= MIN_SAMPLE && lastHour.nonOkShare > 0.5;
  const fast = lastFiveMinutes.perSecond > 5;
  const nearQuota = day.percent >= 80;

  if (failing) {
    reasons.push(`${Math.round(lastHour.nonOkShare * 100)}% of the last hour's requests failed (not 2xx)`);
  }
  if (fast) {
    reasons.push(`the latest 5 minutes ran at ${lastFiveMinutes.perSecond.toFixed(1)} requests per second`);
  }
  if (nearQuota) {
    reasons.push(`the last 24 hours used ${day.percent.toFixed(0)}% of the free daily allowance`);
  }

  if (failing && fast) {
    return {
      level: "STORM",
      reasons,
      nextStep:
        "An old phone page or an old app is retrying. Close it, or update it to the current version. If it keeps going, switch the Worker to the paid plan.",
    };
  }
  if (failing || fast || nearQuota) {
    return {
      level: "WATCH",
      reasons,
      nextStep: "Nothing is broken yet. Check again in an hour; if the numbers keep climbing, find the old page or app that is retrying.",
    };
  }
  return { level: "OK", reasons: [], nextStep: "Nothing to do." };
}

// ---------- reading the login ----------

/** Pull `key = "value"` out of a TOML file, looking only above the first [table] header. */
export function readTomlString(text, key) {
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break;
    const m = line.match(new RegExp(`^\\s*${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`));
    if (m) return m[1] ?? m[2];
  }
  return undefined;
}

export function wranglerConfigPaths(env = process.env, platform = process.platform, home = homedir()) {
  if (platform === "win32") {
    const appData = env.APPDATA || join(home, "AppData", "Roaming");
    return [join(appData, "xdg.config", ".wrangler", "config", "default.toml")];
  }
  return [join(home, ".config", ".wrangler", "config", "default.toml"), join(home, ".wrangler", "config", "default.toml")];
}

function findWranglerConfig() {
  return wranglerConfigPaths().find((p) => existsSync(p)) || null;
}

/** The Worker name: `name` in wrangler.toml, found next to this script (relay/worker) or in the working directory. */
export function workerNameFromToml(scriptDir, cwd = process.cwd()) {
  for (const dir of [resolve(scriptDir, ".."), cwd]) {
    const file = join(dir, "wrangler.toml");
    if (existsSync(file)) {
      const name = readTomlString(readFileSync(file, "utf8"), "name");
      if (name) return name;
    }
  }
  return DEFAULT_WORKER;
}

export function maskAccount(id) {
  return id ? `${id.slice(0, 4)}…` : "unknown";
}

/** Find the token and account id. Environment first, then the wrangler login. Never returns more than needed. */
export async function resolveCredentials(env = process.env, fetchImpl = fetch) {
  let token = env.CLOUDFLARE_API_TOKEN || "";
  let accountId = env.CLOUDFLARE_ACCOUNT_ID || "";
  if (!token) {
    const file = findWranglerConfig();
    if (!file) {
      throw new UsageError("No Cloudflare login found on this computer. Run `npx wrangler login` first, then try again.", 2);
    }
    token = readTomlString(readFileSync(file, "utf8"), "oauth_token") || "";
    if (!token) {
      throw new UsageError("The wrangler login has no token in it. Run `npx wrangler login` again.", 2);
    }
  }
  if (!accountId) {
    const res = await fetchImpl(ACCOUNTS_URL, { headers: { Authorization: `Bearer ${token}` } }).catch((err) => {
      throw new UsageError(`Could not reach Cloudflare (${err.message}). Check the internet connection.`, 4);
    });
    const body = await res.json().catch(() => null);
    if (isRejectedLogin(res.status, body)) throw new UsageError(REJECTED, 2);
    if (res.status === 403) {
      throw new UsageError("The login cannot list accounts. Set CLOUDFLARE_ACCOUNT_ID, or log in again with analytics permission.", 3);
    }
    const accounts = body?.result || [];
    if (!res.ok || accounts.length === 0) {
      throw new UsageError("Cloudflare returned no account for this login. Set CLOUDFLARE_ACCOUNT_ID.", 4);
    }
    if (accounts.length > 1) {
      throw new UsageError("This login can see more than one account. Set CLOUDFLARE_ACCOUNT_ID to the one that runs the relay.", 4);
    }
    accountId = accounts[0].id;
  }
  return { token, accountId };
}

// ---------- the GraphQL query ----------

function analyticsQuery(accountId, scriptName, timeKey, since, until) {
  const dims = timeKey === "datetimeHour" ? "datetimeHour" : "datetimeFiveMinutes";
  return `{
  viewer {
    accounts(filter: { accountTag: ${JSON.stringify(accountId)} }) {
      workersInvocationsAdaptive(
        limit: 10000
        filter: { datetime_geq: ${JSON.stringify(since)}, datetime_leq: ${JSON.stringify(until)}, scriptName: ${JSON.stringify(scriptName)} }
        orderBy: [${dims}_ASC]
      ) {
        dimensions { ${dims} coloCode httpResponseStatus status }
        sum { requests errors subrequests }
      }
    }
  }
}`;
}

async function runQuery(fetchImpl, token, query) {
  const res = await fetchImpl(GRAPHQL_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  }).catch((err) => {
    throw new UsageError(`Could not reach Cloudflare (${err.message}). Check the internet connection.`, 4);
  });
  const body = await res.json().catch(() => null);
  if (isRejectedLogin(res.status, body)) throw new UsageError(REJECTED, 2);
  if (res.status === 403) {
    throw new UsageError("The login does not have permission to read analytics. Log in again with `npx wrangler login` and allow analytics, or use a token that can read Account Analytics.", 3);
  }
  if (!res.ok || !body) throw new UsageError(`Cloudflare answered with status ${res.status}. Try again in a minute.`, 4);
  if (body.errors?.length) {
    const msg = String(body.errors[0].message || "unknown error");
    if (/authoriz|permission|forbidden|not allowed/i.test(msg)) {
      throw new UsageError("The login does not have permission to read analytics. Log in again with `npx wrangler login` and allow analytics.", 3);
    }
    throw new UsageError(`Cloudflare analytics error: ${msg}`, 4);
  }
  const accounts = body.data?.viewer?.accounts || [];
  if (accounts.length === 0) throw new UsageError("Cloudflare did not return this account. Check CLOUDFLARE_ACCOUNT_ID.", 4);
  return accounts[0].workersInvocationsAdaptive || [];
}

/** Fetch both views: hourly for the last 24 h (or --hours if longer), and 5-minute buckets for the last hour. */
export async function fetchUsage({ token, accountId, scriptName, hours, now = Date.now(), fetchImpl = fetch }) {
  const hourSpan = Math.max(hours, 24);
  const until = new Date(now).toISOString();
  const hourRows = await runQuery(fetchImpl, token, analyticsQuery(accountId, scriptName, "datetimeHour", new Date(now - hourSpan * HOUR_MS).toISOString(), until));
  const fiveRows = await runQuery(fetchImpl, token, analyticsQuery(accountId, scriptName, "datetimeFiveMinutes", new Date(now - HOUR_MS).toISOString(), until));
  return { hourRows, fiveRows };
}

// ---------- output ----------

const fmt = (n) => Math.round(n).toLocaleString("en-US");

export function bar(percent, width = 24) {
  const filled = Math.min(width, Math.max(0, Math.round((Math.min(percent, 100) / 100) * width)));
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}]`;
}

export function formatReport({ summary, verdictResult, scriptName, maskedAccount }) {
  const lines = [];
  const s = summary;
  lines.push(`Relay usage for Worker "${scriptName}" (account ${maskedAccount})`);
  lines.push("");
  lines.push("Last 24 hours");
  lines.push(
    `  Requests: ${fmt(s.day.requests)} of ${fmt(s.day.limit)} free per day  ${bar(s.day.percent)} ${s.day.percent.toFixed(1)}%`,
  );
  lines.push("");
  lines.push(`  Not 2xx (failed or retried): ${(s.dayNonOkShare * 100).toFixed(1)}% of the last 24 hours`);
  lines.push("");
  lines.push(`Busiest hours (UTC), last ${s.windowHours} h`);
  if (s.busiestHours.length === 0) lines.push("  No requests in this window.");
  for (const h of s.busiestHours) lines.push(`  ${h.at.slice(0, 16).replace("T", " ")} UTC  ${fmt(h.requests)} requests`);
  lines.push("");
  lines.push(`By HTTP status, last ${s.windowHours} h`);
  for (const st of s.statuses) {
    const label = st.code === 0 ? "no status" : String(st.code);
    lines.push(`  ${label.padEnd(10)} ${fmt(st.requests).padStart(10)}  ${(st.share * 100).toFixed(1).padStart(5)}%`);
  }
  const badOutcomes = s.outcomes.filter((o) => o.outcome !== "ok" && o.requests > 0);
  if (badOutcomes.length) {
    lines.push("  Worker outcomes other than ok:");
    for (const o of badOutcomes) lines.push(`    ${o.outcome}: ${fmt(o.requests)}`);
  }
  lines.push("");
  lines.push(`By data centre (colo), top 5, last ${s.windowHours} h`);
  if (s.colos.length === 0) lines.push("  No requests in this window.");
  for (const c of s.colos) lines.push(`  ${c.colo.padEnd(8)} ${fmt(c.requests).padStart(10)}  ${(c.share * 100).toFixed(1).padStart(5)}%`);
  lines.push("");
  lines.push("Right now");
  lines.push(
    `  Last hour: ${fmt(s.lastHour.requests)} requests, ${(s.lastHour.nonOkShare * 100).toFixed(1)}% not 2xx`,
  );
  lines.push(`  Latest 5 minutes: ${(s.lastFiveMinutes.perSecond).toFixed(2)} requests per second`);
  lines.push("");
  lines.push(`Verdict: ${verdictResult.level}`);
  for (const r of verdictResult.reasons) lines.push(`  - ${r}`);
  lines.push(`  Next step: ${verdictResult.nextStep}`);
  return lines.join("\n");
}

// ---------- main ----------

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      hours: { type: "string", default: "24" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log("usage: node scripts/usage-check.mjs [worker-name] [--hours N] [--json]");
    return 0;
  }
  const hours = Number(values.hours);
  if (!Number.isInteger(hours) || hours < 1 || hours > 744) {
    throw new UsageError("--hours must be a whole number from 1 to 744.", 4);
  }
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const scriptName = positionals[0] || workerNameFromToml(scriptDir);
  const { token, accountId } = await resolveCredentials();
  const { hourRows, fiveRows } = await fetchUsage({ token, accountId, scriptName, hours });
  const summary = summarize({ hourRows, fiveRows, hours });
  const result = verdict(summary);
  const maskedAccount = maskAccount(accountId);
  if (values.json) {
    console.log(JSON.stringify({ worker: scriptName, account: maskedAccount, summary, verdict: result }, null, 2));
  } else {
    console.log(formatReport({ summary, verdictResult: result, scriptName, maskedAccount }));
  }
  return result.level === "STORM" ? 1 : 0;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      if (err instanceof UsageError) {
        console.error(err.message);
        process.exit(err.exitCode);
      }
      console.error(`Usage check failed: ${err.message}`);
      process.exit(4);
    });
}
