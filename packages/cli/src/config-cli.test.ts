/**
 * Config commands against a mock bridge that behaves like the real one: `GET /settings/catalog`,
 * `PATCH /settings`, and the agent consent answers (`CONSENT_PENDING` 503 until the person taps Allow,
 * `CONSENT_DENIED`). Checks argument parsing, the diff output, `--yes` gating and the consent handling.
 */
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { parseConfigArgs, type ConfigArgs } from './args.js';
import { runConfigCli } from './config-cli.js';
import { parseValue, type Catalog, type CatalogEntry } from './commands/settings.js';
import { diffLines, looksSecret, show, type Io } from './output.js';

const entry = (key: string, type: CatalogEntry['type'], def: unknown, saved: unknown, effective = saved, labs = false): CatalogEntry => ({
  key,
  type,
  default: def,
  saved,
  effective,
  labs,
});

function catalog(override = false): Catalog {
  return {
    settings: [
      entry('lend_enabled', 'boolean', false, false, override ? true : false, true),
      entry('night_shift_enabled', 'boolean', false, true, true, true),
      entry('away_minutes', 'number', 5, 5),
      entry('handoff_mode', 'string', 'new_agent', 'new_agent'),
      entry('agent_default_models', 'object', {}, {}),
    ],
    labs: ['lend_enabled', 'night_shift_enabled'],
    dev_labs_override: override,
    refused: ['ui_mode', 'anthropic_api_key', 'openai_api_key'],
  };
}

interface Seen {
  method: string;
  url: string;
  body: unknown;
  pane?: string;
}

class MockBridge {
  seen: Seen[] = [];
  /** Answers for PATCH /settings, one per call; the last repeats. */
  patchAnswers: Array<{ status: number; body: unknown }> = [{ status: 200, body: { ok: true } }];
  catalogBody: Catalog = catalog();
  routes = new Map<string, unknown>();
  private server?: Server;
  port = 0;

  constructor(private portFile: string) {}

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as { port: number }).port;
    writeFileSync(this.portFile, `127.0.0.1:${this.port}\n`);
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  patches(): Seen[] {
    return this.seen.filter((s) => s.method === 'PATCH');
  }

  private async handle(req: IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const url = req.url ?? '';
    this.seen.push({
      method: req.method ?? '',
      url,
      body: raw ? JSON.parse(raw) : undefined,
      pane: req.headers['x-potato-workspace-pane'] as string | undefined,
    });
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && url === '/settings/catalog') return send(200, this.catalogBody);
    if (req.method === 'PATCH' && url === '/settings') {
      const answer = this.patchAnswers.length > 1 ? this.patchAnswers.shift()! : this.patchAnswers[0];
      return send(answer.status, answer.body);
    }
    const route = this.routes.get(`${req.method} ${url}`);
    if (route !== undefined) return send(200, route);
    send(404, { error: 'no such route', code: 'NOT_FOUND' });
  }
}

class TestIo implements Io {
  lines: string[] = [];
  errors: string[] = [];
  interactive = false;
  answer = false;
  asked = 0;
  out(line: string) {
    this.lines.push(line);
  }
  err(line: string) {
    this.errors.push(line);
  }
  async confirm() {
    this.asked++;
    return this.answer;
  }
}

const pending = (retry = 5) => ({
  status: 503,
  body: { code: 'CONSENT_PENDING', error: 'A person has to say yes first.', retry_after_ms: retry },
});

describe('parseConfigArgs', () => {
  const parse = (...argv: string[]) => parseConfigArgs(argv) as ConfigArgs;

  it('keeps --yes from swallowing the next word', () => {
    const a = parse('settings', 'set', '--yes', 'away_minutes', '9');
    assert.equal(a.yes, true);
    assert.deepEqual(a.positional, ['set', 'away_minutes', '9']);
  });

  it('reads the flags and the command', () => {
    const a = parse('labs', 'on', 'lend_enabled', '--dry-run', '--json', '--wait-ms', '250');
    assert.equal(a.command, 'labs');
    assert.deepEqual([a.dryRun, a.json, a.yes, a.waitMs], [true, true, false, 250]);
  });

  it('treats a negative number as a value and rejects unknown flags', () => {
    assert.deepEqual(parse('settings', 'set', 'away_minutes', '-1').positional, ['set', 'away_minutes', '-1']);
    assert.deepEqual(parseConfigArgs(['settings', 'list', '--force']), { problem: 'unknown flag --force' });
    assert.match((parseConfigArgs(['settings', 'list', '--wait-ms', 'soon']) as { problem: string }).problem, /wait-ms/);
  });
});

describe('parseValue', () => {
  it('follows the key type', () => {
    assert.equal(parseValue(entry('a', 'boolean', false, false), 'on'), true);
    assert.equal(parseValue(entry('a', 'boolean', false, false), 'FALSE'), false);
    assert.equal(parseValue(entry('a', 'number', 5, 5), '12'), 12);
    assert.equal(parseValue(entry('a', 'string', '', ''), '"file"'), 'file');
    assert.equal(parseValue(entry('a', 'string', '', ''), 'file'), 'file');
    assert.deepEqual(parseValue(entry('a', 'object', {}, {}), '{"claude":"sonnet"}'), { claude: 'sonnet' });
  });

  it('refuses a wrong type with a plain sentence', () => {
    assert.throws(() => parseValue(entry('away_minutes', 'number', 5, 5), 'soon'), /away_minutes takes a number/);
    assert.throws(() => parseValue(entry('lend_enabled', 'boolean', false, false), 'maybe'), /true or false/);
    assert.throws(() => parseValue(entry('agent_default_models', 'object', {}, {}), '[1]'), /JSON object/);
  });
});

describe('diff and secrets', () => {
  it('prints from -> to, and says when nothing changes', () => {
    assert.deepEqual(
      diffLines([
        { key: 'lend_enabled', from: false, to: true },
        { key: 'away_minutes', from: 5, to: 5 },
      ]),
      ['lend_enabled: false -> true', 'away_minutes: 5 (no change)'],
    );
  });

  it('never shows a value for a secret-looking key', () => {
    assert.equal(looksSecret('openai_api_key'), true);
    assert.equal(show('openai_api_key', 'sk-live'), '[hidden]');
    assert.deepEqual(diffLines([{ key: 'bot_token', from: 'a', to: 'b' }]), ['bot_token: [hidden] -> [hidden]']);
  });
});

describe('potato-workspace config commands (mock bridge)', () => {
  let dir: string;
  let bridge: MockBridge;
  let io: TestIo;
  let savedEnv: Record<string, string | undefined>;

  const run = (...argv: string[]) => runConfigCli(argv, io, '9.9.9');

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pw-cli-'));
    savedEnv = {
      port: process.env.POTATO_WORKSPACE_BRIDGE_PORT_FILE,
      pane: process.env.POTATO_WORKSPACE_PANE_ID,
    };
    delete process.env.POTATO_WORKSPACE_PANE_ID;
    process.env.POTATO_WORKSPACE_BRIDGE_PORT_FILE = join(dir, 'bridge.port');
    bridge = new MockBridge(join(dir, 'bridge.port'));
    await bridge.start();
    io = new TestIo();
  });

  afterEach(async () => {
    await bridge.stop();
    for (const [key, name] of [['port', 'POTATO_WORKSPACE_BRIDGE_PORT_FILE'], ['pane', 'POTATO_WORKSPACE_PANE_ID']] as const) {
      if (savedEnv[key] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[key];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('settings list and get read the catalog and write nothing', async () => {
    assert.equal(await run('settings', 'list'), 0);
    assert.ok(io.lines.some((l) => l.startsWith('away_minutes') && l.includes('number') && l.includes('5')));
    io.lines = [];
    assert.equal(await run('settings', 'get', 'handoff_mode'), 0);
    assert.deepEqual(io.lines, ['handoff_mode: "new_agent"']);
    assert.equal(bridge.patches().length, 0);
  });

  it('settings get --json prints one parseable object', async () => {
    assert.equal(await run('settings', 'get', 'away_minutes', '--json'), 0);
    assert.deepEqual(JSON.parse(io.lines[0]), { key: 'away_minutes', type: 'number', default: 5, saved: 5, effective: 5 });
  });

  it('a change without --yes and no terminal shows the diff, exits 5 and sends nothing', async () => {
    assert.equal(await run('settings', 'set', 'away_minutes', '9'), 5);
    assert.deepEqual(io.lines, ['away_minutes: 5 -> 9']);
    assert.match(io.errors.join('\n'), /--yes/);
    assert.equal(bridge.patches().length, 0);
  });

  it('--yes applies exactly the diffed values in one PATCH', async () => {
    assert.equal(await run('settings', 'set', 'away_minutes', '9', 'handoff_mode', 'file', '--yes'), 0);
    assert.deepEqual(io.lines, ['away_minutes: 5 -> 9', 'handoff_mode: "new_agent" -> "file"', 'Done.']);
    assert.equal(bridge.patches().length, 1);
    assert.deepEqual(bridge.patches()[0].body, { away_minutes: 9, handoff_mode: 'file' });
  });

  it('--dry-run never applies, even with --yes', async () => {
    assert.equal(await run('settings', 'set', 'away_minutes', '9', '--yes', '--dry-run'), 0);
    assert.equal(bridge.patches().length, 0);
    assert.ok(io.lines.includes('Dry run: nothing was changed.'));
  });

  it('setting a value that is already there sends nothing', async () => {
    assert.equal(await run('settings', 'set', 'away_minutes', '5', '--yes'), 0);
    assert.equal(bridge.patches().length, 0);
    assert.ok(io.lines.includes('Nothing to change.'));
  });

  it('at a terminal a y applies and an n does not', async () => {
    io.interactive = true;
    io.answer = false;
    assert.equal(await run('settings', 'set', 'away_minutes', '9'), 5);
    assert.equal(bridge.patches().length, 0);
    io.answer = true;
    assert.equal(await run('settings', 'set', 'away_minutes', '9'), 0);
    assert.equal(io.asked, 2);
    assert.equal(bridge.patches().length, 1);
  });

  it('settings reset sends null so the default comes back', async () => {
    bridge.catalogBody.settings.find((e) => e.key === 'away_minutes')!.saved = 20;
    assert.equal(await run('settings', 'reset', 'away_minutes', '--yes'), 0);
    assert.deepEqual(bridge.patches()[0].body, { away_minutes: null });
    assert.equal(io.lines[0], 'away_minutes: 20 -> 5');
  });

  it('refuses ui_mode, provider keys and keys outside the allowlist with exit 6 and sends nothing', async () => {
    for (const key of ['ui_mode', 'openai_api_key', 'some_unknown_key', 'not a key']) {
      io = new TestIo();
      assert.equal(await run('settings', 'set', key, 'x', '--yes'), 6, key);
      assert.equal(await run('settings', 'get', key), 6, key);
    }
    assert.equal(bridge.patches().length, 0);
    assert.ok(!bridge.seen.some((s) => JSON.stringify(s.body ?? '').includes('openai_api_key')));
  });

  it('checks every pair before sending any (a bad value stops the whole set)', async () => {
    assert.equal(await run('settings', 'set', 'away_minutes', '9', 'lend_enabled', 'maybe', '--yes'), 1);
    assert.equal(bridge.patches().length, 0);
  });

  it('labs list shows saved and in effect, and says when a dev build lies', async () => {
    bridge.catalogBody = catalog(true);
    assert.equal(await run('labs', 'list'), 0);
    const lend = io.lines.find((l) => l.startsWith('lend_enabled'))!;
    assert.match(lend, /false\s+true/);
    assert.ok(io.lines.some((l) => /development build/.test(l)));
  });

  it('labs on/off change only Labs keys and obey --yes', async () => {
    assert.equal(await run('labs', 'on', 'lend_enabled'), 5);
    assert.equal(bridge.patches().length, 0);
    assert.equal(await run('labs', 'on', 'lend_enabled', '--yes'), 0);
    assert.deepEqual(bridge.patches()[0].body, { lend_enabled: true });
    assert.equal(await run('labs', 'on', 'away_minutes', '--yes'), 6);
    assert.equal(bridge.patches().length, 1);
  });

  it('the pane header is sent from an agent window, and a CONSENT_PENDING call waits then goes through', async () => {
    process.env.POTATO_WORKSPACE_PANE_ID = 'pane-7';
    bridge.patchAnswers = [pending(), pending(), { status: 200, body: { ok: true } }];
    assert.equal(await run('settings', 'set', 'away_minutes', '9', '--yes'), 0);
    assert.equal(bridge.patches().length, 3, 'the same call is made again after each wait');
    assert.ok(bridge.patches().every((p) => p.pane === 'pane-7'));
    assert.deepEqual(bridge.patches()[0].body, bridge.patches()[2].body);
    const notes = io.errors.filter((l) => /Allow card/.test(l));
    assert.equal(notes.length, 1, 'tells the person once, not on every retry');
    assert.equal(io.lines.at(-1), 'Done.');
  });

  it('CONSENT_DENIED exits 6 and says nothing changed', async () => {
    bridge.patchAnswers = [pending(), { status: 503, body: { code: 'CONSENT_DENIED', error: 'The person said no.' } }];
    assert.equal(await run('settings', 'set', 'away_minutes', '9', '--yes'), 6);
    assert.match(io.errors.join('\n'), /said no.*Nothing was changed/);
    assert.equal(io.lines.includes('Done.'), false);
  });

  it('gives up with exit 1 when nobody answers within --wait-ms', async () => {
    bridge.patchAnswers = [pending(5)];
    assert.equal(await run('settings', 'set', 'away_minutes', '9', '--yes', '--wait-ms', '60'), 1);
    assert.match(io.errors.join('\n'), /has not answered the Allow card/);
    assert.ok(bridge.patches().length >= 2);
  });

  it('other refusals are reported with their code', async () => {
    bridge.patchAnswers = [{ status: 409, body: { code: 'RESOURCE_LOCKED', error: 'busy' } }];
    assert.equal(await run('settings', 'set', 'away_minutes', '9', '--yes'), 1);
    assert.match(io.errors.join('\n'), /409, RESOURCE_LOCKED/);
  });

  it('exits 4 when the app is not running', async () => {
    await bridge.stop();
    process.env.POTATO_WORKSPACE_BRIDGE_PORT_FILE = join(dir, 'missing.port');
    assert.equal(await run('settings', 'list'), 4);
    assert.match(io.errors.join('\n'), /not running/);
  });

  it('status, agents, models and projects only read', async () => {
    bridge.routes.set('GET /health', { ok: true, version: '1.1.3', build_kind: 'debug', profile: 'dev', tool_count: 84 });
    bridge.routes.set('GET /agents/types', {
      agents: [{ id: 'claude', label: 'Claude Code', installed: true, dispatchable: true, definition: { path: 'C:/secret/path', env: { A: 'b' } } }],
    });
    bridge.routes.set('GET /phone/new-chat/models?agent=claude', { default_model: 'sonnet', models: ['sonnet', 'haiku'] });
    bridge.routes.set('GET /workspace/state', { panes: [{ cwd: 'D:/proj', killed: false }, { cwd: 'D:/proj' }, { cwd: 'D:/gone', killed: true }] });

    assert.equal(await run('status'), 0);
    assert.ok(io.lines.some((l) => l.includes('1.1.3')));
    io = new TestIo();
    assert.equal(await run('agents', 'list', '--json'), 0);
    assert.deepEqual(JSON.parse(io.lines[0]), [{ id: 'claude', name: 'Claude Code', installed: true, dispatchable: true, experimental: false, source: null }]);
    assert.ok(!io.lines.join('').includes('secret'), 'no definition paths or env');
    io = new TestIo();
    assert.equal(await run('models', 'list', 'claude'), 0);
    assert.deepEqual(io.lines, ['default: sonnet', 'sonnet', 'haiku']);
    io = new TestIo();
    assert.equal(await run('projects', 'list'), 0);
    assert.ok(io.lines[0].includes('D:/proj') && io.lines[0].startsWith('2'));
    assert.equal(bridge.patches().length, 0);
  });
});
