/**
 * `standby list|add|remove|close` against a mock bridge that behaves like the app's `/config/*` routes:
 * `GET /config/standby`, `POST /config/plan` (returns lines and a plan id), `POST /config/apply` (the plan id; an agent's
 * apply meets `CONSENT_PENDING` until the person taps Allow, then goes through, or `CONSENT_DENIED`).
 */
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { parseConfigArgs, type ConfigArgs } from './args.js';
import { runConfigCli } from './config-cli.js';
import type { Io } from './output.js';

interface Seen {
  method: string;
  url: string;
  body: any;
  pane?: string;
}

class MockApp {
  seen: Seen[] = [];
  helpers: any[] = [
    { id: 'sb-1', name: 'Reviewer', agent: 'codex', model: 'gpt-5', state: 'ready', after_task: 'wait', warm: false },
    { id: 'sb-2', name: 'Free one', agent: 'opencode', model: null, state: 'ready', after_task: 'close', warm: true },
  ];
  /** Answers to `POST /config/apply`, one per call; the last repeats. */
  applyAnswers: Array<{ status: number; body: unknown }> = [{ status: 200, body: { applied: true, lines: [], standby_added: [{ id: 'sb-9', name: 'Cheap helper' }] } }];
  planAnswer: { status: number; body: unknown } | null = null;
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

  calls(url: string): Seen[] {
    return this.seen.filter((s) => s.url === url);
  }

  private async handle(req: IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const url = req.url ?? '';
    const body = raw ? JSON.parse(raw) : undefined;
    this.seen.push({ method: req.method ?? '', url, body, pane: req.headers['x-potato-workspace-pane'] as string | undefined });
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (req.method === 'GET' && url === '/config/standby') return send(200, { helpers: this.helpers, max: 4, idle_minutes: 30 });
    if (req.method === 'POST' && url === '/config/plan') {
      if (this.planAnswer) return send(this.planAnswer.status, this.planAnswer.body);
      const lines = (body.ops as any[]).map((op) => `${op.kind}: ${op.name ?? op.target}`);
      return send(200, { plan_id: 'plan-1', lines, changes: [], changes_anything: true });
    }
    if (req.method === 'POST' && url === '/config/apply') {
      const answer = this.applyAnswers.length > 1 ? this.applyAnswers.shift()! : this.applyAnswers[0];
      return send(answer.status, answer.body);
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

describe('parseConfigArgs for standby', () => {
  const parse = (...argv: string[]) => parseConfigArgs(argv) as ConfigArgs;

  it('reads the value flags and keeps the words that follow', () => {
    const a = parse('standby', 'add', '--name', 'Cheap helper', '--agent', 'opencode', '--model', 'deepseek/deepseek-chat', '--yes');
    assert.deepEqual(a.positional, ['add']);
    assert.deepEqual(a.values, { name: 'Cheap helper', agent: 'opencode', model: 'deepseek/deepseek-chat' });
    assert.equal(a.yes, true);
  });

  it('refuses a value flag with no value', () => {
    assert.deepEqual(parseConfigArgs(['standby', 'add', '--name']), { problem: '--name needs a value' });
    assert.deepEqual(parseConfigArgs(['standby', 'add', '--name', '--yes']), { problem: '--name needs a value' });
  });
});

describe('potato-workspace standby (mock app)', () => {
  let dir: string;
  let app: MockApp;
  let io: TestIo;
  let saved: Record<string, string | undefined>;
  const run = (...argv: string[]) => runConfigCli(argv, io, '9.9.9');

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pw-standby-'));
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

  it('lists the standbys, and says which one is a free warm agent', async () => {
    assert.equal(await run('standby', 'list'), 0);
    const text = io.lines.join('\n');
    assert.match(text, /Reviewer\s+codex\s+gpt-5\s+ready/);
    assert.match(text, /Free one\s+opencode\s+\(agent default\)\s+ready \(free warm agent\)/);
    io.lines = [];
    assert.equal(await run('standby', 'list', '--json'), 0);
    assert.equal(JSON.parse(io.lines[0]).helpers.length, 2);
  });

  it('plans, shows the plan, then applies that plan by its id with --yes', async () => {
    const code = await run('standby', 'add', '--name', 'Cheap helper', '--agent', 'opencode', '--model', 'deepseek/deepseek-chat', '--yes');
    assert.equal(code, 0, io.errors.join('\n'));
    assert.deepEqual(app.calls('/config/plan')[0].body, { ops: [{ kind: 'standby_add', name: 'Cheap helper', agent: 'opencode', model: 'deepseek/deepseek-chat' }] });
    assert.deepEqual(app.calls('/config/apply')[0].body, { plan_id: 'plan-1' });
    assert.deepEqual(io.lines, ['standby_add: Cheap helper', 'Done.']);
  });

  it('changes nothing without --yes (exit 5) and never on a dry run', async () => {
    assert.equal(await run('standby', 'close', 'Reviewer'), 5);
    assert.equal(app.calls('/config/apply').length, 0, 'the plan was shown, nothing applied');
    assert.match(io.errors.join('\n'), /Nothing was changed/);
    assert.equal(await run('standby', 'close', 'Reviewer', '--yes', '--dry-run'), 0);
    assert.equal(app.calls('/config/apply').length, 0);
    assert.ok(io.lines.includes('Dry run: nothing was changed.'));
  });

  it('remove and close are different plans', async () => {
    assert.equal(await run('standby', 'remove', 'Reviewer', '--yes'), 0);
    assert.equal(await run('standby', 'close', 'sb-2', '--yes'), 0);
    const kinds = app.calls('/config/plan').map((c) => c.body.ops[0]);
    assert.deepEqual(kinds, [
      { kind: 'standby_remove', target: 'Reviewer' },
      { kind: 'standby_close', target: 'sb-2' },
    ]);
  });

  it('needs a name and an agent to add', async () => {
    assert.equal(await run('standby', 'add', '--agent', 'opencode'), 1);
    assert.match(io.errors.join('\n'), /needs --name and --agent/);
    assert.equal(app.calls('/config/plan').length, 0);
  });

  it('a stale plan is reported and nothing is retried', async () => {
    app.applyAnswers = [{ status: 409, body: { code: 'PLAN_STALE', message: 'The app changed since this plan was made, so nothing was changed.' } }];
    assert.equal(await run('standby', 'close', 'Reviewer', '--yes'), 1);
    assert.match(io.errors.join('\n'), /PLAN_STALE/);
    assert.equal(app.calls('/config/apply').length, 1);
  });

  it('from an agent window the apply waits for the person, then goes through with the same plan', async () => {
    process.env.POTATO_WORKSPACE_PANE_ID = 'pane-7';
    app.applyAnswers = [
      { status: 503, body: { code: 'CONSENT_PENDING', error: 'A person has to say yes first.', retry_after_ms: 5 } },
      { status: 200, body: { applied: true, lines: [], standby_added: [] } },
    ];
    assert.equal(await run('standby', 'add', '--name', 'Cheap helper', '--agent', 'opencode', '--yes'), 0, io.errors.join('\n'));
    const applies = app.calls('/config/apply');
    assert.equal(applies.length, 2);
    assert.deepEqual(applies[0].body, applies[1].body, 'the same call again, so the one card covers it');
    assert.equal(applies[0].pane, 'pane-7', 'the bridge is told which window asked');
    assert.match(io.errors.join('\n'), /Waiting for the person/);
  });

  it('a Deny changes nothing and exits 6', async () => {
    process.env.POTATO_WORKSPACE_PANE_ID = 'pane-7';
    app.applyAnswers = [{ status: 403, body: { code: 'CONSENT_DENIED', error: 'The person said no.' } }];
    assert.equal(await run('standby', 'close', 'Reviewer', '--yes'), 6);
    assert.match(io.errors.join('\n'), /said no/);
  });

  it('shows the plan refusal in plain words', async () => {
    app.planAnswer = { status: 404, body: { code: 'NOT_FOUND', message: 'There is no standby called "Nobody".' } };
    assert.equal(await run('standby', 'close', 'Nobody', '--yes'), 1);
    assert.match(io.errors.join('\n'), /no standby called "Nobody"/);
  });
});
