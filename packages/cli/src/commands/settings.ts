/**
 * `settings list|get|set|reset` and `labs list|on|off`.
 *
 * Everything goes through the bridge: `GET /settings/catalog` says which keys exist (the app's own
 * allowlists, `PATCHABLE_KEYS` and `DEV_LABS_KEYS`), `PATCH /settings` writes. A changing command shows
 * a diff first; nothing is written without `--yes` (or a person's y at a terminal). Secrets are never
 * printed and the keys a patch never writes (`ui_mode`, provider keys) are refused here with a sentence.
 */
import { CliError, EXIT, type Bridge } from '../bridge.js';
import type { ConfigArgs } from '../args.js';
import { isKeyName } from '../args.js';
import { diffLines, isNoChange, looksSecret, show, table, type Change, type Io } from '../output.js';

export interface CatalogEntry {
  key: string;
  type: 'boolean' | 'number' | 'string' | 'object' | 'array' | 'any';
  default: unknown;
  saved: unknown;
  effective: unknown;
  labs: boolean;
}

export interface Catalog {
  settings: CatalogEntry[];
  labs: string[];
  dev_labs_override: boolean;
  refused: string[];
}

export async function loadCatalog(bridge: Bridge): Promise<Catalog> {
  return bridge.get<Catalog>('/settings/catalog');
}

/** The entry for `key`, or a CliError that says why it cannot be used. */
export function entryFor(catalog: Catalog, key: string): CatalogEntry {
  if (!isKeyName(key) || catalog.refused.includes(key) || looksSecret(key)) {
    throw new CliError(EXIT.refused, `"${key}" cannot be read or changed from the command line.`);
  }
  const entry = catalog.settings.find((e) => e.key === key);
  if (!entry) {
    throw new CliError(EXIT.refused, `"${key}" is not a setting the command line may change. Run "settings list" to see them.`);
  }
  return entry;
}

/** The typed value for `raw`, following the key's type. Throws CliError (exit 1) for a wrong type. */
export function parseValue(entry: CatalogEntry, raw: string): unknown {
  const bad = (want: string) =>
    new CliError(EXIT.failed, `${entry.key} takes ${want}, got ${JSON.stringify(raw)}.`);
  const text = raw.trim();
  switch (entry.type) {
    case 'boolean': {
      if (/^(true|on|yes)$/i.test(text)) return true;
      if (/^(false|off|no)$/i.test(text)) return false;
      throw bad('true or false');
    }
    case 'number': {
      const n = Number(text);
      if (text === '' || !Number.isFinite(n)) throw bad('a number');
      return n;
    }
    case 'string': {
      // `"quoted"` JSON strings are unwrapped; anything else is taken as typed.
      if (text.startsWith('"')) {
        try {
          const parsed = JSON.parse(text);
          if (typeof parsed === 'string') return parsed;
        } catch {
          /* fall through: use it as typed */
        }
      }
      return raw;
    }
    case 'object':
    case 'array': {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw bad(`JSON (${entry.type === 'object' ? '{"agent":"model"}' : '[...]'})`);
      }
      const isObject = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
      if (entry.type === 'object' ? !isObject : !Array.isArray(parsed)) throw bad(`a JSON ${entry.type}`);
      return parsed;
    }
    default: {
      // Unknown type (default is null): JSON when it parses, else the text.
      try {
        return JSON.parse(text);
      } catch {
        return raw;
      }
    }
  }
}

interface Ctx {
  bridge: Bridge;
  io: Io;
  args: ConfigArgs;
}

function usage(message: string): never {
  throw new CliError(EXIT.failed, message);
}

/** Shows the diff, then applies it only with `--yes` (or a y at a terminal). Returns the exit code. */
export async function applyChanges(ctx: Ctx, changes: Change[], patch: Record<string, unknown>): Promise<number> {
  const { io, args, bridge } = ctx;
  const effective = changes.filter((c) => !isNoChange(c));
  // JSON mode prints one object at the end instead of the diff lines.
  if (!args.json) for (const line of diffLines(changes)) io.out(line);
  if (effective.length === 0) {
    if (args.json) io.out(JSON.stringify({ changes, applied: false, reason: 'no change' }));
    else io.out('Nothing to change.');
    return EXIT.ok;
  }
  if (args.dryRun) {
    if (args.json) io.out(JSON.stringify({ changes, applied: false, reason: 'dry run' }));
    else io.out('Dry run: nothing was changed.');
    return EXIT.ok;
  }
  if (!args.yes) {
    if (io.interactive && !args.json) {
      if (!(await io.confirm('Apply this change? [y/N] '))) {
        io.out('Nothing was changed.');
        return EXIT.needsConfirmation;
      }
    } else {
      if (args.json) io.out(JSON.stringify({ changes, applied: false, reason: 'needs --yes' }));
      io.err('Nothing was changed. Run the same command again with --yes to apply it.');
      return EXIT.needsConfirmation;
    }
  }
  await bridge.patch('/settings', patch);
  if (args.json) io.out(JSON.stringify({ changes, applied: true }));
  else io.out('Done.');
  return EXIT.ok;
}

function patchAndChanges(
  assignments: Array<[CatalogEntry, unknown]>,
): { changes: Change[]; patch: Record<string, unknown> } {
  const changes: Change[] = [];
  const patch: Record<string, unknown> = {};
  for (const [entry, value] of assignments) {
    changes.push({ key: entry.key, from: entry.saved, to: value });
    patch[entry.key] = value;
  }
  return { changes, patch };
}

export async function runSettings(ctx: Ctx): Promise<number> {
  const { bridge, io, args } = ctx;
  const [sub, ...rest] = args.positional;
  const catalog = await loadCatalog(bridge);
  switch (sub) {
    case 'list': {
      if (args.json) {
        io.out(JSON.stringify(catalog.settings.map(({ key, type, default: d, saved, effective, labs }) => ({ key, type, default: d, saved, effective, labs }))));
        return EXIT.ok;
      }
      const rows = catalog.settings.map((e) => [e.key, e.type, show(e.key, e.effective), e.labs ? 'labs' : '']);
      for (const line of table(rows)) io.out(line);
      return EXIT.ok;
    }
    case 'get': {
      if (rest.length !== 1) usage('usage: potato-workspace settings get KEY');
      const entry = entryFor(catalog, rest[0]);
      if (args.json) {
        io.out(JSON.stringify({ key: entry.key, type: entry.type, default: entry.default, saved: entry.saved, effective: entry.effective }));
        return EXIT.ok;
      }
      io.out(`${entry.key}: ${show(entry.key, entry.effective)}`);
      if (JSON.stringify(entry.saved) !== JSON.stringify(entry.effective)) {
        io.out(`saved: ${show(entry.key, entry.saved)} (a development build shows every Labs switch as on)`);
      }
      return EXIT.ok;
    }
    case 'set': {
      if (rest.length === 0 || rest.length % 2 !== 0) usage('usage: potato-workspace settings set KEY VALUE [KEY VALUE ...]');
      const assignments: Array<[CatalogEntry, unknown]> = [];
      const seen = new Set<string>();
      for (let i = 0; i < rest.length; i += 2) {
        const entry = entryFor(catalog, rest[i]);
        if (seen.has(entry.key)) usage(`${entry.key} is given twice.`);
        seen.add(entry.key);
        assignments.push([entry, parseValue(entry, rest[i + 1])]);
      }
      const { changes, patch } = patchAndChanges(assignments);
      return applyChanges(ctx, changes, patch);
    }
    case 'reset': {
      if (rest.length !== 1) usage('usage: potato-workspace settings reset KEY');
      const entry = entryFor(catalog, rest[0]);
      const changes: Change[] = [{ key: entry.key, from: entry.saved, to: entry.default }];
      return applyChanges(ctx, changes, { [entry.key]: null });
    }
    default:
      return usage('usage: potato-workspace settings list | get KEY | set KEY VALUE [KEY VALUE ...] | reset KEY');
  }
}

export async function runLabs(ctx: Ctx): Promise<number> {
  const { bridge, io, args } = ctx;
  const [sub, ...rest] = args.positional;
  const catalog = await loadCatalog(bridge);
  const labs = catalog.settings.filter((e) => catalog.labs.includes(e.key));
  switch (sub) {
    case 'list': {
      if (args.json) {
        io.out(JSON.stringify({ dev_labs_override: catalog.dev_labs_override, labs: labs.map((e) => ({ key: e.key, saved: e.saved, in_effect: e.effective })) }));
        return EXIT.ok;
      }
      const rows = [['KEY', 'SAVED', 'IN EFFECT'], ...labs.map((e) => [e.key, show(e.key, e.saved), show(e.key, e.effective)])];
      for (const line of table(rows)) io.out(line);
      if (catalog.dev_labs_override) io.out('This is a development build: every Labs switch is in effect no matter what is saved.');
      return EXIT.ok;
    }
    case 'on':
    case 'off': {
      if (rest.length !== 1) usage(`usage: potato-workspace labs ${sub} KEY`);
      const entry = entryFor(catalog, rest[0]);
      if (!catalog.labs.includes(entry.key)) {
        throw new CliError(EXIT.refused, `"${entry.key}" is not a Labs switch. Run "labs list" to see them.`);
      }
      const want = sub === 'on';
      const code = await applyChanges(ctx, [{ key: entry.key, from: entry.saved, to: want }], { [entry.key]: want });
      if (code === EXIT.ok && !want && catalog.dev_labs_override && !args.dryRun) {
        io.err('Note: this is a development build, so the switch still shows as on in the app.');
      }
      return code;
    }
    default:
      return usage('usage: potato-workspace labs list | on KEY | off KEY');
  }
}
