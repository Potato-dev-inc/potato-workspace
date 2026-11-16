/**
 * `crew list|show|validate` against a mock bridge that answers like the app's read-only `/crews` routes.
 * The commands never change anything: the mock records every call, and the tests check there is no write.
 */
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { parseConfigArgs } from './args.js';
import { runConfigCli } from './config-cli.js';
import type { Io } from './output.js';

interface Seen {
  method: string;
  url: string;
  body: any;
}

const OUR_WAY = {
  id: 'template:our-way',
  kind: 'template',
  crew: {
    name: 'Our way',
    routing_file: 'difficulty.md',
    budget: { turns: 300, minutes: 600 },
    max_helpers: 16,
    fix_loops: 2,
    roles: [
      { id: 'lead', name: 'Lead', agent_type: 'claude', model: 'opus', permissions: { read: true, write: 'scoped', write_scope: 'plans', run: 'ask', start_helpers: true, merge: true }, hands_to: ['scout'] },
      { id: 'scout', name: 'Scout', agent_type: 'claude', model: 'haiku', parent: 'lead', standbys: 1, permissions: { read: true, write: 'none', run: 'read-only' } },
    ],
  },
  problems: [],
  routing_text: '# How work is routed',
};

class MockApp {
  seen: Seen[] = [];
  private server?: Server;

  constructor(private portFile: string) {}

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    writeFileSync(this.portFile, `127.0.0.1:${(this.server.address() as { port: number }).port}\n`);
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private async handle(req: IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const url = req.url ?? '';
    const body = raw ? JSON.parse(raw) : undefined;
    this.seen.push({ method: req.method ?? '', url, body });
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (req.method === 'GET' && url === '/crews') {
      return send(200, {
        crews: [{ slug: 'mine', name: 'Mine', roles: 2, agents: ['claude', 'codex'], problem: null }],
        templates: [{ slug: 'template:our-way', name: 'Our way', roles: 6, agents: ['claude', 'opencode'], problem: 'The agent "opencode" for Worker (medium) is not set up here.' }],
      });
    }
    if (req.method === 'GET' && url === '/crews/template:our-way') return send(200, OUR_WAY);
    if (req.method === 'GET' && url.startsWith('/crews/')) return send(404, { code: 'CREW_NOT_FOUND', error: 'There is no such crew.' });
    if (req.method === 'POST' && url === '/crews/validate') {
      const bad = String(body.text).includes('mystery');
      return send(200, {
        ok: !bad,
        kind: 'crew',
        crews: [{ id: 'crew', name: 'Solo', roles: 1, problems: bad ? [{ code: 'CREW_AGENT_UNKNOWN', role: 'Lead', message: 'The agent "mystery" for Lead is not set up here.' }] : [] }],
        problems: [],
      });
    }
    send(404, { error: 'no such route', code: 'NOT_FOUND' });
  }
}

class TestIo implements Io {
  lines: string[] = [];
  errors: string[] = [];
  interactive = false;
  out(line: string) {
    this.lines.push(line);
  }
  err(line: string) {
    this.errors.push(line);
  }
  async confirm() {
    return false;
  }
}

describe('parseConfigArgs for crew', () => {
  it('knows the crew command and keeps its words', () => {
    const a = parseConfigArgs(['crew', 'show', 'template:our-way', '--json']);
    assert.ok(!('problem' in a));
    if ('problem' in a) return;
    assert.equal(a.command, 'crew');
    assert.deepEqual(a.positional, ['show', 'template:our-way']);
    assert.equal(a.json, true);
  });
});

describe('potato-workspace crew (mock app)', () => {
  let dir: string;
  let app: MockApp;
  let io: TestIo;
  let saved: Record<string, string | undefined>;
  const run = (...argv: string[]) => runConfigCli(argv, io, '9.9.9');
  const file = (name: string, text: string) => {
    const path = join(dir, name);
    writeFileSync(path, text);
    return path;
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pw-crew-'));
    saved = { port: process.env.POTATO_WORKSPACE_BRIDGE_PORT_FILE, pane: process.env.POTATO_WORKSPACE_PANE_ID };
    delete process.env.POTATO_WORKSPACE_PANE_ID;
    process.env.POTATO_WORKSPACE_BRIDGE_PORT_FILE = join(dir, 'bridge.port');
    app = new MockApp(join(dir, 'bridge.port'));
    await app.start();
    io = new TestIo();
  });

  afterEach(async () => {
    await app.stop();
    for (const [key, name] of [['port', 'POTATO_WORKSPACE_BRIDGE_PORT_FILE'], ['pane', 'POTATO_WORKSPACE_PANE_ID']] as const) {
      if (saved[key] === undefined) delete process.env[name];
      else process.env[name] = saved[key];
    }
  });

  it('lists saved crews and the template, and says what is wrong with a row', async () => {
    assert.equal(await run('crew', 'list'), 0);
    const text = io.lines.join('\n');
    assert.match(text, /mine\s+saved\s+Mine\s+2\s+claude, codex\s+ok/);
    assert.match(text, /template:our-way\s+template\s+Our way\s+6\s+claude, opencode\s+problem: The agent "opencode"/);
    io.lines = [];
    assert.equal(await run('crew', 'list', '--json'), 0);
    assert.equal(JSON.parse(io.lines[0]).templates.length, 1);
  });

  it('shows one crew: limits, each role with its agent, model, warm count, hand-offs and permissions', async () => {
    assert.equal(await run('crew', 'show', 'template:our-way'), 0);
    const text = io.lines.join('\n');
    assert.match(text, /Our way \(template, read-only\)/);
    assert.match(text, /routing file: difficulty\.md/);
    assert.match(text, /budget: 300 turns, 600 minutes/);
    assert.match(text, /most helpers at once: 16/);
    assert.match(text, /most fix loops: 2/);
    assert.match(text, /lead\s+claude\s+opus\s+-\s+0\s+scout\s+read, write in plans, run ask, starts helpers, merges/);
    assert.match(text, /scout\s+claude\s+haiku\s+lead\s+1\s+-\s+read, no write, run read-only/);
    assert.match(text, /problems: none/);
  });

  it('says plainly when there is no such crew', async () => {
    assert.equal(await run('crew', 'show', 'nope'), 1);
    assert.match(io.errors.join('\n'), /There is no such crew/);
  });

  it('validates a file: exit 0 with nothing changed, exit 1 with the problem named on its role', async () => {
    const good = file('good.toml', 'name = "Solo"\n');
    assert.equal(await run('crew', 'validate', good), 0);
    assert.match(io.lines.join('\n'), /crew: Solo, 1 roles, ok[\s\S]*This crew file is fine\. Nothing was changed\./);
    io.lines = [];
    const bad = file('bad.toml', 'name = "Solo"\nagent = "mystery"\n');
    assert.equal(await run('crew', 'validate', bad), 1);
    const text = io.lines.join('\n');
    assert.match(text, /1 problem/);
    assert.match(text, /CREW_AGENT_UNKNOWN \(Lead\): The agent "mystery"/);
    assert.match(text, /has problems\. Nothing was changed\./);
    io.lines = [];
    assert.equal(await run('crew', 'validate', bad, '--json'), 1);
    assert.equal(JSON.parse(io.lines[0]).ok, false);
  });

  it('sends the text of the file as it is, and never makes a write call', async () => {
    await run('crew', 'validate', file('x.toml', 'name = "Solo"\n'));
    const posts = app.seen.filter((s) => s.method !== 'GET');
    assert.deepEqual(posts.map((p) => [p.method, p.url, p.body]), [['POST', '/crews/validate', { text: 'name = "Solo"\n' }]]);
    io.lines = [];
    await run('crew', 'list');
    await run('crew', 'show', 'template:our-way');
    assert.equal(app.seen.filter((s) => s.method !== 'GET').length, 1, 'list and show only read');
    assert.ok(app.seen.every((s) => s.url.startsWith('/crews')), 'only crew routes were called');
  });

  it('a missing file, a missing name and an unknown subcommand fail before asking the app', async () => {
    assert.equal(await run('crew', 'validate', join(dir, 'nothing.toml')), 1);
    assert.match(io.errors.join('\n'), /no such file/);
    for (const argv of [['crew'], ['crew', 'show'], ['crew', 'validate'], ['crew', 'apply', 'x'], ['crew', 'list', 'extra']]) {
      io.errors = [];
      assert.equal(await run(...argv), 1, argv.join(' '));
      assert.match(io.errors.join('\n'), /usage: potato-workspace crew list \| show ID \| validate FILE/);
    }
    assert.equal(app.seen.length, 0);
  });
});
