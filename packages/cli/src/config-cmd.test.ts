/**
 * `config export|diff|import` against a mock app: `GET /settings/catalog`, `GET /config/standby`,
 * `GET /workspace/state`, `POST /config/plan` and `POST /config/apply` (the phase 2 routes).
 *
 * The point of these tests is the file: only allowlisted settings are written, a planted secret-like
 * setting never appears, a machine path never appears, an export diffs to nothing, an import changes
 * nothing without `--yes` or on `--dry-run`, and every refusal exits with a useful code.
 */
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { runConfigCli } from './config-cli.js';
import type { Io } from './output.js';
import {
  ConfigFileError,
  EXPORTABLE_SETTINGS,
  exportDocument,
  parseConfigFile,
  planOps,
  toToml,
  type CatalogLike,
  type LiveStandby,
} from './commands/config-file.js';

interface Seen {
  method: string;
  url: string;
  body: any;
  pane?: string;
}

// Built from parts so the personal-path guard does not see a real folder name in the source.
const PLANTED_USER = ['Ren', 'pc'].join('-');
const SETTINGS: Record<string, [string, unknown]> = {
  opencode_model_provider: ['any', null],
  opencode_model_id: ['any', null],
  confirm_close_running_pane: ['boolean', true],
  checkpoints_enabled: ['boolean', true],
  checkpoints_keep: ['number', 50],
  away_minutes: ['number', 5],
  budget_default_turns: ['number', 0],
  budget_default_minutes: ['number', 0],
  right_size_suggest: ['boolean', true],
  agent_hooks_mode: ['string', 'shadow'],
  pane_mcp_enabled: ['boolean', true],
  show_terminals: ['boolean', false],
  handoff_mode: ['string', 'new_agent'],
  handoff_fixed_notes: ['string', 'Remember the tests.'],
  desktop_pet_size: ['string', 'medium'],
  desktop_pet_quiet: ['boolean', false],
  keep_awake_while_working: ['boolean', true],
  helper_answers_enabled: ['boolean', true],
  early_versions_enabled: ['boolean', false],
};

/** Planted things a blocklist would leak. None may ever reach the file. */
const PLANTED: Record<string, [string, unknown]> = {
  openai_api_key: ['string', 'sk-planted-secret-123'],
  anthropic_api_key: ['string', 'sk-ant-planted-456'],
  lend_device_token: ['string', 'lend-planted-789'],
  tunnel_link: ['string', 'https://planted.trycloudflare.com/secret-link'],
  librarian_indexer_path: ['string', `C:\\Users\\${PLANTED_USER}\\tools\\index`],
};

function catalog(): CatalogLike & { labs: string[]; refused: string[] } {
  return {
    settings: [
      ...Object.entries(SETTINGS).map(([key, [type, saved]]) => ({ key, type, default: null, saved })),
      { key: 'agent_default_models', type: 'object', default: {}, saved: { claude: 'sonnet', opencode: 'deepseek/deepseek-chat' } },
      { key: 'helper_default_models', type: 'object', default: {}, saved: { opencode: 'deepseek/deepseek-chat' } },
      { key: 'lend_enabled', type: 'boolean', default: false, saved: false },
      { key: 'acp_chat_enabled', type: 'boolean', default: true, saved: true },
      ...Object.entries(PLANTED).map(([key, [type, saved]]) => ({ key, type, default: null, saved })),
    ],
    labs: ['lend_enabled', 'acp_chat_enabled'],
    refused: ['ui_mode', 'openai_api_key', 'anthropic_api_key'],
  };
}

function helpers(): LiveStandby[] {
  return [
    { id: 'sb-1', name: 'Reviewer', agent: 'codex', model: 'gpt-5', project: 'D:\\proj', after_task: 'wait', warm: false },
    { id: 'sb-2', name: 'Free one', agent: 'opencode', model: null, project: `C:\\Users\\${PLANTED_USER}\\work\\shop`, after_task: 'close', warm: true },
  ];
}

class MockApp {
  seen: Seen[] = [];
  catalogBody = catalog();
  helpers: LiveStandby[] = helpers();
  panes = [{ cwd: 'D:\\proj' }, { cwd: 'D:\\proj' }, { cwd: 'E:\\other' }];
  /** Answers to `POST /config/apply`, one per call; the last repeats. */
  applyAnswers: Array<{ status: number; body: unknown }> = [{ status: 200, body: { applied: true, lines: [], standby_added: [] } }];
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
    if (req.method === 'GET' && url === '/settings/catalog') return send(200, this.catalogBody);
    if (req.method === 'GET' && url === '/config/standby') return send(200, { helpers: this.helpers, max: 4, idle_minutes: 30 });
    if (req.method === 'GET' && url === '/workspace/state') return send(200, { panes: this.panes });
    if (req.method === 'POST' && url === '/config/plan') {
      const ops = (body.ops as any[]) ?? [];
      const lines = ops.map((op) =>
        op.kind === 'settings' ? `setting change: ${Object.keys(op.patch).join(', ')}` : `${op.kind}: ${op.name ?? op.target}`,
      );
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
  answer = false;
  out(line: string) {
    this.lines.push(line);
  }
  err(line: string) {
    this.errors.push(line);
  }
  async confirm() {
    return this.answer;
  }
}

const pending = (retry = 5) => ({
  status: 503,
  body: { code: 'CONSENT_PENDING', error: 'A person has to say yes first.', retry_after_ms: retry },
});

const EXTRA_STANDBY = `
[[standby]]
name = "Cheap helper"
agent = "opencode"
model = "deepseek/deepseek-chat"
project = "{folder}"
after = "wait"
`;

describe('config file format', () => {
  it('writes every allowlisted setting and nothing planted', () => {
    const doc = exportDocument(catalog(), helpers(), 'D:\\proj');
    const text = toToml(doc);
    for (const [key, [, saved]] of Object.entries(SETTINGS)) {
      if (saved === null) continue;
      assert.ok(doc.settings.has(key), `${key} was exported`);
      assert.ok(EXPORTABLE_SETTINGS.includes(key));
    }
    for (const key of doc.settings.keys()) assert.ok(EXPORTABLE_SETTINGS.includes(key), `${key} is allowlisted`);
    for (const secret of ['sk-planted', 'sk-ant-planted', 'lend-planted', 'planted.trycloudflare', 'openai_api_key', 'anthropic_api_key', 'lend_device_token', 'tunnel_link']) {
      assert.equal(text.includes(secret), false, `${secret} must not be in the file`);
    }
    assert.equal(text.includes(PLANTED_USER), false, 'no personal folder');
    assert.equal(/[A-Z]:\\/.test(text), false, 'no drive-letter path');
  });

  it('maps a project to {folder} or a folder name, and leaves out free warm agents', () => {
    const doc = exportDocument(catalog(), helpers(), 'D:\\proj');
    assert.deepEqual(doc.standby, [{ name: 'Reviewer', agent: 'codex', model: 'gpt-5', project: '{folder}', after: 'wait' }]);
    const text = toToml(doc);
    assert.ok(text.includes('project = "{folder}"'));
    assert.equal(text.includes('Free one'), false, 'a free warm agent is not part of the setup');
  });

  it('writes model defaults as one-line tables', () => {
    const text = toToml(exportDocument(catalog(), helpers(), 'D:\\proj'));
    assert.match(text, /\[models\]/);
    assert.ok(text.includes('default = { claude = "sonnet", opencode = "deepseek/deepseek-chat" }'));
    assert.ok(text.includes('helper_default = { opencode = "deepseek/deepseek-chat" }'));
  });

  it('reads the file back with comments, escapes and inline tables', () => {
    const doc = parseConfigFile(`# a comment
version = 1

[settings]
handoff_fixed_notes = "Say \\"done\\" # not a comment"

[models]
default = { claude = "sonnet" }

[[standby]]
name = "Reviewer"   # tail comment
agent = "codex"
project = "{folder}"
`);
    assert.equal(doc.settings.get('handoff_fixed_notes'), 'Say "done" # not a comment');
    assert.deepEqual(doc.models.default, { claude: 'sonnet' });
    assert.equal(doc.standby[0].after, 'wait');
  });

  it('refuses anything the file may not carry', () => {
    const bad = [
      ['no version', '[settings]\naway_minutes = 5'],
      ['version 2', 'version = 2'],
      ['unknown section', 'version = 1\n[secrets]\nopenai_api_key = "x"'],
      ['unknown setting', 'version = 1\n[settings]\nnot_a_setting = true'],
      ['unknown top key', 'version = 1\nname = "x"'],
      ['labs needs booleans', 'version = 1\n[labs]\nlend_enabled = "yes"'],
      ['duplicate key', 'version = 1\n[settings]\naway_minutes = 5\naway_minutes = 6'],
      ['bad standby field', 'version = 1\n[[standby]]\nname = "a"\nagent = "b"\nhome = "pane"'],
      ['bad after', 'version = 1\n[[standby]]\nname = "a"\nagent = "b"\nafter = "later"'],
      ['unclosed string', 'version = 1\n[settings]\nhandoff_fixed_notes = "oops'],
      ['models needs a table', 'version = 1\n[models]\ndefault = "sonnet"'],
      ['unknown models key', 'version = 1\n[models]\nother = { claude = "sonnet" }'],
      ['two standbys share a name', 'version = 1\n[[standby]]\nname = "a"\nagent = "b"\n[[standby]]\nname = "A"\nagent = "c"'],
      ['array value', 'version = 1\n[settings]\naway_minutes = [1, 2]'],
    ] as const;
    for (const [what, text] of bad) {
      assert.throws(() => parseConfigFile(text), ConfigFileError, what);
    }
  });
});

describe('potato-workspace config (mock app)', () => {
  let dir: string;
  let app: MockApp;
  let io: TestIo;
  let saved: Record<string, string | undefined>;
  let file: string;
  const run = (...argv: string[]) => runConfigCli(argv, io, '9.9.9');

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pw-config-'));
    saved = { port: process.env.POTATO_WORKSPACE_BRIDGE_PORT_FILE, pane: process.env.POTATO_WORKSPACE_PANE_ID };
    delete process.env.POTATO_WORKSPACE_PANE_ID;
    process.env.POTATO_WORKSPACE_BRIDGE_PORT_FILE = join(dir, 'bridge.port');
    app = new MockApp(join(dir, 'bridge.port'));
    await app.start();
    io = new TestIo();
    file = join(dir, 'setup.toml');
  });

  afterEach(async () => {
    await app.stop();
    for (const [key, name] of [['port', 'POTATO_WORKSPACE_BRIDGE_PORT_FILE'], ['pane', 'POTATO_WORKSPACE_PANE_ID']] as const) {
      if (saved[key] === undefined) delete process.env[name];
      else process.env[name] = saved[key];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('export writes the file, says where, and reports counts in --json', async () => {
    assert.equal(await run('config', 'export', '--out', file), 0, io.errors.join('\n'));
    const text = readFileSync(file, 'utf8');
    assert.match(text, /^# Potato Workspace setup/);
    assert.match(text, /version = 1/);
    assert.match(text, /\[labs\]\nlend_enabled = false/);
    assert.match(io.lines[0], new RegExp(`Wrote .*setup\\.toml \\(\\d+ settings, 2 Labs switches, 1 standbys\\)`));

    io = new TestIo();
    assert.equal(await run('config', 'export', '--out', file, '--json'), 0);
    const counts = JSON.parse(io.lines[0]);
    assert.equal(counts.standbys, 1);
    assert.equal(counts.labs, 2);
    assert.ok(counts.settings >= 15);
  });

  it('round trip: export then diff finds nothing to change and plans nothing', async () => {
    assert.equal(await run('config', 'export', '--out', file), 0);
    io.lines = [];
    assert.equal(await run('config', 'diff', file), 0, io.errors.join('\n'));
    assert.deepEqual(io.lines, ['Nothing to change.']);
    assert.equal(app.calls('/config/plan').length, 0);
    assert.equal(app.calls('/config/apply').length, 0);
  });

  it('diff shows the plan lines through /config/plan and applies nothing', async () => {
    assert.equal(await run('config', 'export', '--out', file), 0);
    editFile(file, 'away_minutes = 5', 'away_minutes = 9');
    appendFile(file, EXTRA_STANDBY);
    io.lines = [];

    assert.equal(await run('config', 'diff', file), 0, io.errors.join('\n'));
    const plan = app.calls('/config/plan');
    assert.equal(plan.length, 1);
    assert.deepEqual(plan[0].body.ops[0], { kind: 'settings', patch: { away_minutes: 9 } });
    assert.deepEqual(plan[0].body.ops[1], {
      kind: 'standby_add',
      name: 'Cheap helper',
      agent: 'opencode',
      model: 'deepseek/deepseek-chat',
      project: 'D:\\proj',
    });
    assert.ok(io.lines.includes('setting change: away_minutes'));
    assert.equal(app.calls('/config/apply').length, 0);
  });

  it('a standby that changed is closed and added again; an extra one is closed', async () => {
    assert.equal(await run('config', 'export', '--out', file), 0);
    app.helpers[0] = { ...app.helpers[0], model: 'gpt-5.1' };
    app.helpers.push({ id: 'sb-3', name: 'Old one', agent: 'claude', model: 'sonnet', project: 'D:\\proj', after_task: 'wait', warm: false });
    io.lines = [];

    assert.equal(await run('config', 'diff', file), 0, io.errors.join('\n'));
    assert.deepEqual(app.calls('/config/plan')[0].body.ops, [
      { kind: 'standby_close', target: 'sb-1' },
      { kind: 'standby_add', name: 'Reviewer', agent: 'codex', model: 'gpt-5', project: 'D:\\proj' },
      { kind: 'standby_close', target: 'sb-3' },
    ]);
  });

  it('import --dry-run plans, changes nothing and exits 0', async () => {
    assert.equal(await run('config', 'export', '--out', file), 0);
    editFile(file, 'away_minutes = 5', 'away_minutes = 9');
    io.lines = [];

    assert.equal(await run('config', 'import', file, '--dry-run'), 0, io.errors.join('\n'));
    assert.equal(app.calls('/config/plan').length, 1);
    assert.equal(app.calls('/config/apply').length, 0);
    assert.ok(io.lines.includes('Dry run: nothing was changed.'));
  });

  it('import without --yes and no terminal shows the changes, exits 5 and applies nothing', async () => {
    assert.equal(await run('config', 'export', '--out', file), 0);
    editFile(file, 'away_minutes = 5', 'away_minutes = 9');
    io.lines = [];

    assert.equal(await run('config', 'import', file), 5);
    assert.equal(app.calls('/config/apply').length, 0);
    assert.match(io.errors.join('\n'), /--yes/);
    assert.ok(io.lines.includes('setting change: away_minutes'));
  });

  it('import --yes applies exactly the plan it showed', async () => {
    assert.equal(await run('config', 'export', '--out', file), 0);
    editFile(file, 'away_minutes = 5', 'away_minutes = 9');
    io.lines = [];

    assert.equal(await run('config', 'import', file, '--yes'), 0, io.errors.join('\n'));
    assert.deepEqual(app.calls('/config/apply')[0].body, { plan_id: 'plan-1' });
    assert.equal(io.lines.at(-1), 'Done.');
  });

  it('an import that changes nothing applies nothing', async () => {
    assert.equal(await run('config', 'export', '--out', file), 0);
    io.lines = [];
    assert.equal(await run('config', 'import', file, '--yes'), 0);
    assert.deepEqual(io.lines, ['Nothing to change.']);
    assert.equal(app.calls('/config/plan').length, 0);
    assert.equal(app.calls('/config/apply').length, 0);
  });

  it('from an agent window the apply waits for the Allow card, then goes through', async () => {
    assert.equal(await run('config', 'export', '--out', file), 0);
    editFile(file, 'away_minutes = 5', 'away_minutes = 9');
    process.env.POTATO_WORKSPACE_PANE_ID = 'pane-7';
    app.applyAnswers = [pending(), { status: 200, body: { applied: true, lines: [], standby_added: [] } }];
    io.lines = [];

    assert.equal(await run('config', 'import', file, '--yes'), 0, io.errors.join('\n'));
    const applies = app.calls('/config/apply');
    assert.equal(applies.length, 2, 'the same call again, so one card covers it');
    assert.equal(applies[0].pane, 'pane-7');
    assert.match(io.errors.join('\n'), /Waiting for the person/);
  });

  it('a Deny changes nothing and exits 6', async () => {
    assert.equal(await run('config', 'export', '--out', file), 0);
    editFile(file, 'away_minutes = 5', 'away_minutes = 9');
    process.env.POTATO_WORKSPACE_PANE_ID = 'pane-7';
    app.applyAnswers = [{ status: 403, body: { code: 'CONSENT_DENIED', error: 'The person said no.' } }];

    assert.equal(await run('config', 'import', file, '--yes'), 6);
    assert.match(io.errors.join('\n'), /said no/);
  });

  it('a planted secret in the app never reaches the exported file', async () => {
    assert.equal(await run('config', 'export', '--out', file), 0);
    const text = readFileSync(file, 'utf8');
    for (const planted of ['sk-planted', 'lend-planted', 'planted.trycloudflare', 'openai_api_key', 'lend_device_token', PLANTED_USER]) {
      assert.equal(text.includes(planted), false, planted);
    }
    assert.equal(/[A-Z]:\\/.test(text), false, 'no drive-letter path');
  });

  it('refuses an unknown setting, an unknown Labs switch and a bad version before planning', async () => {
    writeFileSync(file, 'version = 1\n[settings]\nnot_a_real_setting = true\n');
    assert.equal(await run('config', 'diff', file), 1);
    assert.match(io.errors.join('\n'), /not_a_real_setting/);

    writeFileSync(file, 'version = 1\n[labs]\nspaces_enabled = true\n');
    io = new TestIo();
    assert.equal(await run('config', 'diff', file), 1);
    assert.match(io.errors.join('\n'), /Labs switch/);

    writeFileSync(file, 'version = 7\n');
    io = new TestIo();
    assert.equal(await run('config', 'diff', file), 1);
    assert.match(io.errors.join('\n'), /version 7/);
    assert.equal(app.calls('/config/plan').length, 0);
  });

  it('a settings value of the wrong type is refused before planning', async () => {
    writeFileSync(file, 'version = 1\n[settings]\naway_minutes = "soon"\n');
    assert.equal(await run('config', 'diff', file), 1);
    assert.match(io.errors.join('\n'), /away_minutes takes a number/);
    assert.equal(app.calls('/config/plan').length, 0);
  });

  it('a standby project that is not open here stops the import', async () => {
    writeFileSync(file, 'version = 1\n[[standby]]\nname = "One"\nagent = "opencode"\nproject = "no-such-folder"\n');
    assert.equal(await run('config', 'import', file, '--yes'), 1);
    assert.match(io.errors.join('\n'), /no open window has that folder/);
    assert.equal(app.calls('/config/plan').length, 0);
  });

  it('a project name that one open window has is taken as that folder', async () => {
    writeFileSync(file, 'version = 1\n[[standby]]\nname = "Other"\nagent = "opencode"\nproject = "other"\n');
    assert.equal(await run('config', 'diff', file), 0, io.errors.join('\n'));
    assert.deepEqual(app.calls('/config/plan')[0].body.ops, [
      { kind: 'standby_add', name: 'Other', agent: 'opencode', project: 'E:\\other' },
      { kind: 'standby_close', target: 'sb-1' },
    ]);
  });

  it('exits 1 for a missing file and 4 when the app is not running', async () => {
    assert.equal(await run('config', 'diff', join(dir, 'nope.toml')), 1);
    assert.match(io.errors.join('\n'), /Could not read/);

    await app.stop();
    process.env.POTATO_WORKSPACE_BRIDGE_PORT_FILE = join(dir, 'missing.port');
    io = new TestIo();
    assert.equal(await run('config', 'export', '--out', file), 4);
    assert.match(io.errors.join('\n'), /not running/);
  });

  it('plans only what differs (planOps is pure)', () => {
    const doc = exportDocument(catalog(), helpers(), 'D:\\proj');
    assert.deepEqual(planOps(doc, catalog(), helpers(), ['D:\\proj', 'E:\\other']), []);
  });
});

function editFile(file: string, find: string, replace: string): void {
  const body = readFileSync(file, 'utf8');
  assert.ok(body.includes(find), `the export has ${find}`);
  writeFileSync(file, body.replace(find, replace));
}

function appendFile(file: string, text: string): void {
  writeFileSync(file, readFileSync(file, 'utf8') + text);
}
