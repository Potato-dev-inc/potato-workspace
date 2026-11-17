// Run every test of the Worker variant, locally. Nothing here touches a Cloudflare account: the Worker
// runs under `wrangler dev` (Miniflare/workerd) with throwaway storage, no login, no network.
//
//   npm test                 everything
//   npm run test:worker      the Worker's own tests (node:test) against two local servers
//   npm run test:app         the Rust end-to-end tests (relay/server/tests/protocol.rs and the app's
//                            relay_end_to_end tests), pointed at the local Worker
//
// Needs Rust (cargo) for the Rust parts. Set CARGO_TARGET_DIR to keep build output out of the repo.
import { spawn, spawnSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const worker = resolve(here, "..");
const relay = resolve(worker, "..");
const app = resolve(relay, "..", "packages", "app", "src-tauri");
const wrangler = join(worker, "node_modules", "wrangler", "bin", "wrangler.js");
const args = new Set(process.argv.slice(2));
const only = args.has("--worker-only") ? "worker" : args.has("--app-only") ? "app" : args.has("--pair-app") ? "pair-app" : "all";

/** The public key id of `key(21)` in test/proto.mjs (seed byte 21): the owner of the pairing test Worker. */
function pairOwnerId() {
  const secret = Buffer.alloc(32, 21);
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), secret]), format: "der", type: "pkcs8" });
  return Buffer.from(createPublicKey(privateKey).export({ format: "jwk" }).x, "base64url").toString("base64url");
}

const children = [];
const scratch = mkdtempSync(join(tmpdir(), "pm-relay-worker-"));
let failed = false;

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

/** `wrangler dev` on a free port with its own empty storage. Resolves with the base URL when it answers. */
async function startWorker(name, vars) {
  const port = await freePort();
  const varArgs = Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`]);
  const child = spawn(
    process.execPath,
    [wrangler, "dev", "--ip", "127.0.0.1", "--port", String(port), "--persist-to", join(scratch, name), ...varArgs],
    { cwd: worker, env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" }, stdio: ["ignore", "pipe", "pipe"] },
  );
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  children.push(child);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i += 1) {
    if (child.exitCode !== null) throw new Error(`wrangler dev (${name}) exited:\n${log}`);
    try {
      const res = await fetch(`${base}/v1/health`);
      if (res.ok) return base;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`wrangler dev (${name}) did not start:\n${log}`);
}

function stopAll() {
  for (const child of children) {
    if (child.exitCode !== null) continue;
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else child.kill("SIGTERM");
  }
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    // workerd may still hold a file for a moment
  }
}

function run(label, cmd, cmdArgs, options) {
  console.log(`\n=== ${label}`);
  const result = spawnSync(cmd, cmdArgs, { stdio: "inherit", ...options });
  if (result.status !== 0) {
    failed = true;
    console.error(`=== FAILED: ${label}`);
  }
}

process.on("exit", stopAll);
process.on("SIGINT", () => process.exit(130));

try {
  if (only === "pair-app") {
    // Far-away pairing, end to end with the app's own client: two PCs pair through a local Worker.
    const pairOn = await startWorker("pair-app", { PAIR_OWNER: pairOwnerId() });
    run("far-away pairing through the real Worker (Rust)", "cargo", ["test", "--lib", "--", "far_worker_loopback"], { cwd: app, env: { ...process.env, PM_PAIR_URL: pairOn } });
    if (failed) process.exitCode = 1;
    process.exit(failed ? 1 : 0);
  }
  if (only === "all") {
    run("protocol checks (Rust, native)", "cargo", ["test", "-p", "pm-relay-wasm"], { cwd: relay });
  }
  const hooked = await startWorker("hooked", {
    TEST_HOOKS: "1",
    LIMIT_UNAUTH_PER_IP_PER_HOUR: "100000",
    LIMIT_ROOMS_PER_ADDRESS_PER_HOUR: "100000",
    LIMIT_ROOM_VIEWS_PER_MINUTE: "100000",
    ALLOWED_ORIGIN_RE: "^http://127\\.0\\.0\\.1:[0-9]+$",
    RATE_LIMIT_PER_HOUR: "100000",
  });
  console.log(`worker with test hooks: ${hooked}`);
  if (only !== "app") {
    const strict = await startWorker("strict", {});
    console.log(`worker as deployed:     ${strict}`);
    run("Worker tests (node)", process.execPath, ["--test", "--test-concurrency=1", join(worker, "test", "worker.test.mjs")], {
      cwd: worker,
      env: { ...process.env, PM_RELAY_TEST_URL: hooked, PM_RELAY_STRICT_URL: strict },
    });
    // The stable phone link: a Worker that only accepts a setup secret (nobody can claim it first).
    const linkSecret = "setup-secret-for-the-strict-test-worker";
    const linkStrict = await startWorker("link-strict", {
      ALLOWED_ORIGIN_RE: "^http://127\\.0\\.0\\.1:[0-9]+$",
      SETUP_SECRET_SHA256: createHash("sha256").update(linkSecret).digest("hex"),
    });
    run("Potato Worker tests: features, invites (node)", process.execPath, ["--test", "--test-concurrency=1", join(worker, "test", "potato.test.mjs")], {
      cwd: worker,
      env: { ...process.env, PM_RELAY_TEST_URL: hooked, PM_RELAY_STRICT_URL: strict },
    });
    run("Stable link tests (node)", process.execPath, ["--test", "--test-concurrency=1", join(worker, "test", "stable.test.mjs")], {
      cwd: worker,
      env: { ...process.env, PM_LINK_URL: hooked, PM_LINK_STRICT_URL: linkStrict, PM_LINK_SETUP_SECRET: linkSecret },
    });
    // Far-away pairing: one Worker with the owner key set (a small box cap), one without (the feature is off).
    const pairOn = await startWorker("pair-on", { PAIR_OWNER: pairOwnerId(), LIMIT_PAIR_MAX_OPEN: "3" });
    const pairOff = await startWorker("pair-off", {});
    run("Far-away pairing tests (node)", process.execPath, ["--test", "--test-concurrency=1", join(worker, "test", "pair.test.mjs")], {
      cwd: worker,
      env: { ...process.env, PM_PAIR_URL: pairOn, PM_PAIR_OFF_URL: pairOff },
    });
    run("Live Room tests (node)", process.execPath, ["--test", "--test-concurrency=1", join(worker, "test", "room.test.mjs")], {
      cwd: worker,
      env: { ...process.env, PM_RELAY_TEST_URL: hooked, PM_RELAY_STRICT_URL: strict },
    });
  }
  if (only !== "worker") {
    const env = { ...process.env, PM_RELAY_TEST_URL: hooked };
    run("relay protocol tests against the Worker (Rust)", "cargo", ["test", "-p", "pm-relay", "--test", "protocol"], { cwd: relay, env });
    run(
      "the app's relay end-to-end tests against the Worker (Rust)",
      "cargo",
      ["test", "--lib", "--", "relay_end_to_end", "on_the_relay_a_removed", "an_envelope_the_relay_drops"],
      { cwd: app, env },
    );
  }
} catch (error) {
  failed = true;
  console.error(error);
}
stopAll();
process.exit(failed ? 1 : 0);
