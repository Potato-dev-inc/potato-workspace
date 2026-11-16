/**
 * `config export|diff|import`: the whole setup as one TOML file.
 *
 * - `export [--out FILE]` writes the allowlisted part of the current setup (see `config-file.ts`).
 *   It reads only, and no secret, token, login, lend or device value has a place in the file.
 * - `diff FILE` shows what applying the file would change. It asks `/config/plan`, which touches
 *   nothing.
 * - `import FILE [--yes] [--dry-run]` plans, shows the same lines, then applies that plan by its id
 *   (`/config/apply`). Without `--yes` and without a terminal it exits 5 with nothing changed.
 *   From an agent's window the apply raises the person's Allow card; the CLI waits for the answer.
 *
 * Both `diff` and `import` check every name in the file against the running app first, so an unknown
 * key or a project that is not open here stops the command before any plan is made.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { CliError, EXIT, type Bridge } from '../bridge.js';
import type { ConfigArgs } from '../args.js';
import type { Io } from '../output.js';
import { loadCatalog } from './settings.js';
import { makePlan, planAndApply } from './plan.js';
import {
  ConfigFileError,
  checkAgainst,
  exportDocument,
  parseConfigFile,
  planOps,
  toToml,
  type ConfigDoc,
  type LiveStandby,
} from './config-file.js';

export const CONFIG_FILE_USAGE =
  'usage: potato-workspace config export [--out FILE] | diff FILE | import FILE [--yes] [--dry-run]';

export const DEFAULT_CONFIG_FILE = 'potato-workspace.toml';

interface Ctx {
  bridge: Bridge;
  io: Io;
  args: ConfigArgs;
}

interface StandbyView {
  helpers: LiveStandby[];
}

interface Pane {
  cwd?: string | null;
  killed?: boolean;
}

/** Open project folders, most windows first (the first is "the folder" for `{folder}`). */
async function openFolders(bridge: Bridge): Promise<string[]> {
  let state: { panes?: Pane[] };
  try {
    state = await bridge.get<{ panes?: Pane[] }>('/workspace/state');
  } catch {
    // An older app may not have this route. The file still works: paths become project names.
    return [];
  }
  const counts = new Map<string, number>();
  for (const pane of state.panes ?? []) {
    if (pane.killed || !pane.cwd) continue;
    counts.set(pane.cwd, (counts.get(pane.cwd) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([folder]) => folder);
}

function asCliError(err: unknown): unknown {
  return err instanceof ConfigFileError ? new CliError(EXIT.failed, err.message) : err;
}

function readDoc(file: string): ConfigDoc {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw new CliError(EXIT.failed, `Could not read ${file}: ${(err as Error).message}`);
  }
  try {
    return parseConfigFile(text);
  } catch (err) {
    throw err instanceof ConfigFileError ? new CliError(EXIT.failed, `${file}: ${err.message}`) : err;
  }
}

async function runExport(ctx: Ctx, rest: string[]): Promise<number> {
  const { bridge, io, args } = ctx;
  if (rest.length > 0) throw new CliError(EXIT.failed, CONFIG_FILE_USAGE);
  const out = args.values.out ?? DEFAULT_CONFIG_FILE;
  const catalog = await loadCatalog(bridge);
  const [view, folders] = await Promise.all([
    bridge.get<StandbyView>('/config/standby'),
    openFolders(bridge),
  ]);
  const doc = exportDocument(catalog, view.helpers, folders[0]);
  const text = toToml(doc);
  try {
    writeFileSync(out, text, 'utf8');
  } catch (err) {
    throw new CliError(EXIT.failed, `Could not write ${out}: ${(err as Error).message}`);
  }
  const counts = { settings: doc.settings.size, labs: doc.labs.size, standbys: doc.standby.length };
  if (args.json) {
    io.out(JSON.stringify({ path: out, ...counts }));
  } else {
    io.out(`Wrote ${out} (${counts.settings} settings, ${counts.labs} Labs switches, ${counts.standbys} standbys).`);
  }
  return EXIT.ok;
}

async function runFileCommand(ctx: Ctx, sub: string, rest: string[]): Promise<number> {
  const { bridge, io, args } = ctx;
  if (rest.length !== 1) throw new CliError(EXIT.failed, CONFIG_FILE_USAGE);
  const file = rest[0];
  const doc = readDoc(file);
  const catalog = await loadCatalog(bridge);
  const [view, folders] = await Promise.all([
    bridge.get<StandbyView>('/config/standby'),
    openFolders(bridge),
  ]);

  let ops: object[];
  try {
    checkAgainst(doc, catalog);
    ops = planOps(doc, catalog, view.helpers, folders);
  } catch (err) {
    throw asCliError(err);
  }

  if (ops.length === 0) {
    if (args.json) io.out(JSON.stringify({ plan: null, changes_anything: false, applied: false, reason: 'no change' }));
    else io.out('Nothing to change.');
    return EXIT.ok;
  }

  if (sub === 'diff') {
    const plan = await makePlan(ctx, ops);
    if (args.json) {
      io.out(JSON.stringify({ plan, applied: false }));
      return EXIT.ok;
    }
    for (const line of plan.lines) io.out(line);
    if (plan.changes_anything === false) io.out('Nothing to change.');
    return EXIT.ok;
  }

  return planAndApply(ctx, ops);
}

export async function runConfig(ctx: Ctx): Promise<number> {
  const [sub, ...rest] = ctx.args.positional;
  switch (sub) {
    case 'export':
      return runExport(ctx, rest);
    case 'diff':
    case 'import':
      return runFileCommand(ctx, sub, rest);
    default:
      throw new CliError(EXIT.failed, CONFIG_FILE_USAGE);
  }
}
