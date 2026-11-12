#!/usr/bin/env node
// Drives the packaged Rust MCP binary over stdio against a mock bridge whose /agents/wait never finishes.
// Asserts a wait_agents that times out gets exactly one response for its id, that progress notifications use only
// the client's own progressToken and stop before the response, and that a cancelled call gets no response.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const binary = process.env.POTATO_WORKSPACE_TEST_MCP_BINARY ?? join(root, 'packages', 'app', 'src-tauri', 'target', 'debug', process.platform === 'win32' ? 'puppet-master-mcp.exe' : 'puppet-master-mcp');
assert.ok(existsSync(binary), `MCP binary missing: ${binary} (set POTATO_WORKSPACE_TEST_MCP_BINARY)`);
const temp = mkdtempSync(join(tmpdir(), 'pm-wait-once-'));
const portFile = join(temp, 'bridge.port');
const out = []; // every line the shim wrote, in order, with its arrival index
let waitSlices = 0;
let server; let client;

const agent = (n) => ({ handle: `h${n}`, status: 'running', stage: 'working', receipt: { note: 'x'.repeat(400) } });
function reply(res, value) {
  const payload = JSON.stringify(value);
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}
const send = (message) => client.stdin.write(`${JSON.stringify(message)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, label, ms = 20_000) {
  const started = Date.now();
  while (Date.now() - started < ms) { if (predicate()) return; await sleep(20); }
  throw new Error(`timed out: ${label}`);
}
const responses = (id) => out.filter((m) => m.id === id && ('result' in m || 'error' in m));

async function main() {
  server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (req.method === 'POST' && req.url.startsWith('/agents/wait')) {
      waitSlices += 1;
      await sleep(300); // a slice that ends early with the non-final reason "timeout"
      return reply(res, { agents: [agent(1), agent(2), agent(3), agent(4)], reason: 'timeout' });
    }
    if (req.method === 'POST' && req.url === '/mcp/mode') return reply(res, { mode: 'agent', tool_count: 9 });
    reply(res, {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  writeFileSync(portFile, `127.0.0.1:${server.address().port}\n`);
  client = spawn(binary, [], { cwd: root, env: { ...process.env, POTATO_WORKSPACE_BRIDGE_PORT_FILE: portFile }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let buffer = '';
  client.stdout.on('data', (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); if (line.trim()) out.push(JSON.parse(line)); }
  });
  client.stderr.on('data', () => {});

  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'wait-once', version: '1' } } });
  await until(() => responses(1).length === 1, 'initialize');
  send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });

  // 1. A wait that times out, with a progress token: one response, progress only with that token and only before it.
  send({ jsonrpc: '2.0', id: 'w1', method: 'tools/call', params: { name: 'wait_agents', arguments: { handles: ['h1', 'h2', 'h3', 'h4'], timeout_ms: 1500 }, _meta: { progressToken: 'tok-1' } } });
  await until(() => responses('w1').length === 1, 'wait_agents response');
  await sleep(1500); // nothing may arrive after the response
  assert.equal(responses('w1').length, 1, 'exactly one response for w1');
  const reply1 = responses('w1')[0];
  assert.equal(reply1.result.structuredContent.reason, 'timeout');
  const at = out.indexOf(reply1);
  const progress = out.filter((m) => m.method === 'notifications/progress');
  assert.ok(progress.length >= 1, 'progress was sent for a call with a token');
  assert.ok(progress.every((m) => m.params.progressToken === 'tok-1'), 'progress uses only the client token');
  assert.ok(progress.every((m) => out.indexOf(m) < at), 'no progress after the response');

  // 2. No progress token: no progress at all.
  const before = out.length;
  send({ jsonrpc: '2.0', id: 'w2', method: 'tools/call', params: { name: 'wait_agents', arguments: { handles: ['h1'], timeout_ms: 1000 } } });
  await until(() => responses('w2').length === 1, 'second wait response');
  await sleep(1000);
  assert.equal(responses('w2').length, 1);
  assert.equal(out.slice(before).filter((m) => m.method === 'notifications/progress').length, 0, 'no token, no progress');

  // 3. Cancelled: no response at all.
  send({ jsonrpc: '2.0', id: 'w3', method: 'tools/call', params: { name: 'wait_agents', arguments: { handles: ['h1'], timeout_ms: 30000 } } });
  await until(() => waitSlices >= 3, 'third wait started');
  send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'w3' } });
  await sleep(2000);
  assert.equal(responses('w3').length, 0, 'a cancelled request gets no response');

  // 4. Every id answered at most once overall.
  const seen = new Map();
  for (const m of out) if (m.id !== undefined && !m.method) seen.set(m.id, (seen.get(m.id) ?? 0) + 1);
  for (const [id, count] of seen) assert.equal(count, 1, `id ${id} answered ${count} times`);
  console.log('wait_agents answers once per id: ok');
}

main().then(() => process.exitCode = 0).catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (client && client.exitCode === null) { client.kill(); await new Promise((resolve) => client.once('exit', resolve)); }
  server?.close();
  rmSync(temp, { recursive: true, force: true });
});
