// A0: the MCP program of the extracted app starts from its real path (with spaces), talks to THIS app's bridge, and its tools match.
// The path is the one the app itself reports in its log ("bundled Rust MCP server"), not one the harness invents.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { sleep } from '../../src/cdp.mjs';

const ANSI = /\u001b\[[0-9;]*m/g;

export function mcpPathFromLog(logText) {
  const line = logText.replace(ANSI, '').split(/\r?\n/).find((l) => /bundled Rust MCP server/.test(l));
  const m = line && /path=(.+)$/.exec(line.trim());
  return m ? m[1].trim() : null;
}

const result_debug = {};
export async function a0({ app, extractRoot }) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  const logText = fs.readFileSync(app.logFile, 'utf8');
  const exe = mcpPathFromLog(logText);
  add('the app reports the program it will start for agents', !!exe, exe || 'no "bundled Rust MCP server" line in the log');
  if (!exe) return finish(checks);
  add('the path is inside the extracted copy', path.resolve(exe).toLowerCase().startsWith(path.resolve(extractRoot).toLowerCase()), exe);
  add('the path has a space in it (like Program Files)', /\s/.test(exe), '');
  add('the path is not a verbatim \\\\?\\ path', !exe.startsWith('\\\\?\\'), exe.slice(0, 40));
  add('the program exists', fs.existsSync(exe), '');
  if (!fs.existsSync(exe)) return finish(checks);

  const portFile = path.join(app.dataDir, 'potato-workspace.bridge.port');
  const child = spawn(exe, [], { env: { ...process.env, POTATO_WORKSPACE_BRIDGE_PORT_FILE: portFile }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const msgs = []; let buf = ''; let err = '';
  child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) { try { msgs.push(JSON.parse(l)); } catch { /* not json */ } } } });
  child.stderr.on('data', (d) => { err += d; });
  const rpc = async (id, method, params) => {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    for (let i = 0; i < 300; i++) { const m = msgs.find((x) => x.id === id); if (m) return m; await sleep(50); }
    throw new Error(`no answer to ${method} in 15 s. stderr: ${err.slice(0, 300)}`);
  };
  try {
    const init = await rpc(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'real-app-check', version: '1' } });
    add('initialize answers', !!init.result, JSON.stringify(init.result?.serverInfo || init.error || {}).slice(0, 120));
    const instr = String(init.result?.instructions || '');
    const driftAt = instr.indexOf('WARNING [SCHEMA_DRIFT]');
    add('no SCHEMA_DRIFT warning (the program and the app are one build)', driftAt < 0, driftAt >= 0 ? instr.slice(Math.max(0, driftAt - 12), driftAt + 650) : 'catalog ' + (init.result?.serverInfo?.catalog_version || ''));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const list = await rpc(2, 'tools/list', {});
    const tools = (list.result?.tools || []).map((t) => t.name);
    add('tools/list returns the tools', tools.length > 5, `${tools.length} tools`);
    const toolsRes = await app.bridge.get('/mcp/tools');
    const app_tools = Array.isArray(toolsRes.body) ? toolsRes.body : (toolsRes.body?.tools || []);
    result_debug.toolsKeys = Array.isArray(toolsRes.body) ? 'array' : Object.keys(toolsRes.body || {}).join(',');
    const appNames = app_tools.map((t) => t.name || t);
    const missing = tools.filter((n) => !appNames.includes(n));
    add('every tool the program lists is served by the app', appNames.length > 0 && missing.length === 0, appNames.length === 0 ? 'the app answered no tool list (' + toolsRes.status + ', ' + result_debug.toolsKeys + ')' : missing.length ? `missing: ${missing.slice(0, 5).join(', ')}` : `${appNames.length} of ${appNames.length}`);
    const pick = ['bridge_health', 'list_agents', 'list_panes'].find((n) => tools.includes(n));
    if (pick) {
      const call = await rpc(3, 'tools/call', { name: pick, arguments: {} });
      const text = JSON.stringify(call.result || call.error || {});
      add(`a tool call (${pick}) reaches the app and answers`, !!call.result && !call.result.isError, text.slice(0, 160));
    } else add('a read-only tool exists to call', false, 'none of bridge_health, list_agents, list_panes');
  } catch (e) {
    add('the program talks over stdio', false, String(e.message || e));
  } finally {
    try { child.stdin.end(); } catch { /* closed */ }
    try { child.kill(); } catch { /* gone */ }
  }
  return finish(checks, { exe });
}

function finish(checks, extra = {}) {
  const failed = checks.filter((c) => !c.ok);
  return { id: 'A0', title: 'The MCP program of the app starts from its real path and works', verdict: failed.length ? 'FAIL' : 'PASS', checks, ...extra };
}
