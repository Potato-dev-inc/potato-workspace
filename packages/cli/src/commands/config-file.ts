/**
 * The setup file: TOML, version 1, an ALLOWLIST of sections.
 *
 * What may be written: the settings in `EXPORTABLE_SETTINGS`, the Labs switches the app lists
 * (`GET /settings/catalog` -> `labs`), the two model-default settings, and standby helpers (name,
 * agent, model, project, after). Nothing else has a place in the file, so a secret, a login, a lend
 * key or a device pairing can never be written by accident: a new key is NOT exported until someone
 * adds it here. A second lock skips any key that looks like a secret (`looksSecret`).
 *
 * Machine paths never appear: a standby's project is written as `{folder}` (the folder that is open
 * when the file is read) or as the project's folder name. `librarian_indexer_path` and the phone
 * preferences are not exported at all.
 *
 * This module has no dependency: it reads and writes the small TOML subset the file needs (tables,
 * arrays of tables, strings, numbers, booleans, one-line inline tables). Anything else is an error
 * with a line number, never silently ignored.
 */
import { looksSecret } from '../output.js';

export const CONFIG_VERSION = 1;
export const FOLDER = '{folder}';

/**
 * Settings the setup file may carry. Keep this in step with `PATCHABLE_KEYS` in
 * `settings_store.rs`: a setting is not exported until it is added here on purpose.
 */
export const EXPORTABLE_SETTINGS: readonly string[] = [
  'opencode_model_provider',
  'opencode_model_id',
  'confirm_close_running_pane',
  'checkpoints_enabled',
  'checkpoints_keep',
  'away_minutes',
  'budget_default_turns',
  'budget_default_minutes',
  'right_size_suggest',
  'agent_hooks_mode',
  'pane_mcp_enabled',
  'show_terminals',
  'handoff_mode',
  'handoff_fixed_notes',
  'desktop_pet_size',
  'desktop_pet_quiet',
  'keep_awake_while_working',
  'jump_out_cards_enabled',
  'helper_answers_enabled',
  'early_versions_enabled',
];

const EXPORTABLE = new Set(EXPORTABLE_SETTINGS);
const MODEL_KEYS = { default: 'agent_default_models', helper_default: 'helper_default_models' } as const;

/** A value the file can carry. */
export type FileValue = string | number | boolean;

export interface FileStandby {
  name: string;
  agent: string;
  model?: string;
  /** `{folder}`, a project folder name, or an absolute folder from a hand-written file. */
  project: string;
  after: 'wait' | 'close';
}

export interface ConfigDoc {
  settings: Map<string, FileValue>;
  labs: Map<string, boolean>;
  models: { default?: Record<string, string>; helper_default?: Record<string, string> };
  standby: FileStandby[];
}

/** A problem with the file itself. The command prints it with the file name and exits 1. */
export class ConfigFileError extends Error {}

/** The smallest view of a catalog entry this module needs (see `commands/settings.ts`). */
export interface CatalogLike {
  settings: Array<{ key: string; type: string; default?: unknown; saved?: unknown }>;
  labs: string[];
  refused?: string[];
}

/** The smallest view of a standby this module needs (`GET /config/standby`). */
export interface LiveStandby {
  id?: string;
  name: string;
  agent: string;
  model?: string | null;
  project: string;
  after_task?: string;
  warm?: boolean;
}

// ------------------------------------------------------------------ export

/** A standby's project as the file writes it: `{folder}` for the open folder, else its folder name. */
export function projectLabel(project: string, currentFolder?: string): string {
  const clean = project.trim();
  if (!clean) return FOLDER;
  if (currentFolder && sameFolder(clean, currentFolder)) return FOLDER;
  const name = lastSegment(clean);
  return name && name !== '.' && name !== '..' ? name : FOLDER;
}

function sameFolder(a: string, b: string): boolean {
  const norm = (path: string) => path.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

function lastSegment(path: string): string {
  const parts = path.trim().replace(/\\/g, '/').replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] ?? '';
}

/** The current setup, restricted to what the file may carry. Reads only. */
export function exportDocument(catalog: CatalogLike, standbys: LiveStandby[], currentFolder?: string): ConfigDoc {
  const doc: ConfigDoc = { settings: new Map(), labs: new Map(), models: {}, standby: [] };
  const byKey = new Map(catalog.settings.map((entry) => [entry.key, entry]));
  const refused = new Set(catalog.refused ?? []);

  for (const key of EXPORTABLE_SETTINGS) {
    const entry = byKey.get(key);
    if (!entry || refused.has(key) || looksSecret(key)) continue;
    const value = entry.saved;
    if (value === null || value === undefined) continue;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue;
    doc.settings.set(key, value);
  }
  for (const key of catalog.labs) {
    const entry = byKey.get(key);
    if (!entry || refused.has(key) || looksSecret(key)) continue;
    if (typeof entry.saved === 'boolean') doc.labs.set(key, entry.saved);
  }
  for (const [section, settingKey] of Object.entries(MODEL_KEYS) as Array<[keyof typeof MODEL_KEYS, string]>) {
    const saved = byKey.get(settingKey)?.saved;
    const models = stringMap(saved);
    if (models) doc.models[section] = models;
  }
  for (const helper of standbys) {
    // A free warm agent was taken off its agent; it is not part of the setup and must not come back as one.
    if (helper.warm) continue;
    const after = helper.after_task === 'close' ? 'close' : 'wait';
    doc.standby.push({
      name: helper.name,
      agent: helper.agent,
      ...(helper.model ? { model: helper.model } : {}),
      project: projectLabel(helper.project, currentFolder),
      after,
    });
  }
  return doc;
}

function stringMap(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') return undefined;
    out[key] = item;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The file text. Sections with nothing to say are left out. */
export function toToml(doc: ConfigDoc): string {
  const lines = [
    '# Potato Workspace setup. Secrets, logins, lending and devices are never in this file.',
    `version = ${CONFIG_VERSION}`,
  ];
  if (doc.settings.size > 0) {
    lines.push('', '[settings]');
    for (const key of EXPORTABLE_SETTINGS) {
      const value = doc.settings.get(key);
      if (value !== undefined) lines.push(`${key} = ${tomlValue(value)}`);
    }
  }
  if (doc.labs.size > 0) {
    lines.push('', '[labs]');
    for (const [key, value] of doc.labs) lines.push(`${key} = ${tomlValue(value)}`);
  }
  const models = Object.entries(doc.models).filter(([, value]) => value !== undefined) as Array<
    [keyof typeof MODEL_KEYS, Record<string, string>]
  >;
  if (models.length > 0) {
    lines.push('', '[models]');
    for (const [section, value] of models) lines.push(`${section} = ${inlineTable(value)}`);
  }
  for (const helper of doc.standby) {
    lines.push('', '[[standby]]');
    lines.push(`name = ${tomlValue(helper.name)}`);
    lines.push(`agent = ${tomlValue(helper.agent)}`);
    if (helper.model) lines.push(`model = ${tomlValue(helper.model)}`);
    lines.push(`project = ${tomlValue(helper.project)}`);
    lines.push(`after = ${tomlValue(helper.after)}`);
  }
  return `${lines.join('\n')}\n`;
}

function tomlValue(value: FileValue): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return Number.isFinite(value) ? String(value) : '0';
}

function inlineTable(map: Record<string, string>): string {
  const parts = Object.keys(map)
    .sort()
    .map((key) => `${key} = ${tomlValue(map[key])}`);
  return `{ ${parts.join(', ')} }`;
}

// ------------------------------------------------------------------ parse

/** Reads the file. Throws `ConfigFileError` (plain sentence, line number) for anything unknown. */
export function parseConfigFile(text: string): ConfigDoc {
  const doc: ConfigDoc = { settings: new Map(), labs: new Map(), models: {}, standby: [] };
  let section: 'none' | 'settings' | 'labs' | 'models' | 'standby' = 'none';
  let standby: FileStandby | null = null;
  let standbyKeys = new Set<string>();
  let sawVersion = false;

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const where = `line ${i + 1}: `;
    const line = stripComment(lines[i]).trim();
    if (!line) continue;

    if (line.startsWith('[[')) {
      if (!line.endsWith(']]')) throw new ConfigFileError(`${where}a section header ends with "]]".`);
      const name = line.slice(2, -2).trim();
      if (name !== 'standby') throw new ConfigFileError(`${where}"${name}" is not a section this file may have.`);
      standby = { name: '', agent: '', project: FOLDER, after: 'wait' };
      standbyKeys = new Set();
      doc.standby.push(standby);
      section = 'standby';
      continue;
    }
    if (line.startsWith('[')) {
      if (!line.endsWith(']')) throw new ConfigFileError(`${where}a section header ends with "]".`);
      const name = line.slice(1, -1).trim();
      standby = null;
      if (name === 'settings' || name === 'labs' || name === 'models') {
        section = name;
        continue;
      }
      throw new ConfigFileError(`${where}"${name}" is not a section this file may have. Allowed: [settings], [labs], [models], [[standby]].`);
    }

    const eq = indexOutsideString(line, '=');
    if (eq < 0) throw new ConfigFileError(`${where}write "key = value".`);
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) throw new ConfigFileError(`${where}"${key}" is not a name this file may use.`);
    const value = parseValue(line.slice(eq + 1).trim(), where);

    if (section === 'none') {
      if (key !== 'version') throw new ConfigFileError(`${where}"${key}" must be inside a section.`);
      if (sawVersion) throw new ConfigFileError(`${where}version is given twice.`);
      if (value !== CONFIG_VERSION) throw new ConfigFileError(`${where}this file says version ${String(value)}. This version reads version ${CONFIG_VERSION}.`);
      sawVersion = true;
      continue;
    }
    if (section === 'settings') {
      if (doc.settings.has(key)) throw new ConfigFileError(`${where}"${key}" is given twice.`);
      if (!EXPORTABLE.has(key)) {
        throw new ConfigFileError(`${where}"${key}" is not a setting this file may change. The file may only change: ${EXPORTABLE_SETTINGS.join(', ')}.`);
      }
      if (typeof value === 'object') throw new ConfigFileError(`${where}"${key}" needs a single value, not a table.`);
      doc.settings.set(key, value);
      continue;
    }
    if (section === 'labs') {
      if (doc.labs.has(key)) throw new ConfigFileError(`${where}"${key}" is given twice.`);
      if (typeof value !== 'boolean') throw new ConfigFileError(`${where}"${key}" needs true or false.`);
      doc.labs.set(key, value);
      continue;
    }
    if (section === 'models') {
      if (key !== 'default' && key !== 'helper_default') {
        throw new ConfigFileError(`${where}"${key}" is not a models key. Use default or helper_default.`);
      }
      if (doc.models[key] !== undefined) throw new ConfigFileError(`${where}"${key}" is given twice.`);
      if (typeof value !== 'object') throw new ConfigFileError(`${where}"${key}" needs a table, like { claude = "sonnet" }.`);
      const models: Record<string, string> = {};
      for (const [agent, model] of Object.entries(value)) {
        if (typeof model !== 'string') throw new ConfigFileError(`${where}${key}.${agent} needs a model name in quotes.`);
        models[agent] = model;
      }
      doc.models[key] = models;
      continue;
    }
    // [[standby]]
    if (!standby) throw new ConfigFileError(`${where}"${key}" must follow a [[standby]] line.`);
    if (standbyKeys.has(key)) throw new ConfigFileError(`${where}"${key}" is given twice in one standby.`);
    standbyKeys.add(key);
    if (key === 'name' || key === 'agent' || key === 'model' || key === 'project' || key === 'after') {
      if (typeof value !== 'string') throw new ConfigFileError(`${where}${key} needs text in quotes.`);
      if (key === 'after') {
        if (value !== 'wait' && value !== 'close') {
          throw new ConfigFileError(`${where}after is "wait" or "close", not "${value}".`);
        }
        standby.after = value;
      } else if (key === 'name') {
        standby.name = value;
      } else if (key === 'agent') {
        standby.agent = value;
      } else if (key === 'model') {
        standby.model = value;
      } else {
        standby.project = value;
      }
      continue;
    }
    throw new ConfigFileError(`${where}a standby has name, agent, model, project and after, not "${key}".`);
  }

  if (!sawVersion) throw new ConfigFileError('the file needs "version = 1" at the top.');
  validateStandbys(doc.standby);
  return doc;
}

function validateStandbys(standbys: FileStandby[]): void {
  const names = new Set<string>();
  for (const [index, helper] of standbys.entries()) {
    const where = `standby ${index + 1}: `;
    if (!helper.name.trim()) throw new ConfigFileError(`${where}a name is needed.`);
    if (!helper.agent.trim()) throw new ConfigFileError(`${where}an agent is needed (for example "opencode").`);
    if (!helper.project.trim()) throw new ConfigFileError(`${where}a project is needed ("{folder}" or a project name).`);
    const lower = helper.name.trim().toLowerCase();
    if (names.has(lower)) throw new ConfigFileError(`${where}two standbys are called "${helper.name}". Use one name each.`);
    names.add(lower);
    helper.name = helper.name.trim();
    helper.agent = helper.agent.trim();
    helper.project = helper.project.trim();
    if (helper.model !== undefined) {
      const model = helper.model.trim();
      if (model) helper.model = model;
      else delete helper.model;
    }
    if (!helper.after) helper.after = 'wait';
  }
}

function parseValue(text: string, where: string): FileValue | Record<string, FileValue> {
  if (!text) throw new ConfigFileError(`${where}the value is missing.`);
  if (text.startsWith('"')) {
    const [value, rest] = readString(text, where);
    if (rest.trim()) throw new ConfigFileError(`${where}unexpected text after the text value.`);
    return value;
  }
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^[+-]?\d+(?:\.\d+)?$/.test(text) && Number.isFinite(Number(text))) return Number(text);
  if (text.startsWith('{')) return parseInlineTable(text, where);
  throw new ConfigFileError(`${where}"${text}" is not a value this file may use (text in quotes, true, false, a number, or { key = "value" }).`);
}

function readString(text: string, where: string): [string, string] {
  let out = '';
  for (let i = 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') return [out, text.slice(i + 1)];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const escape = text[++i];
    switch (escape) {
      case 'n':
        out += '\n';
        break;
      case 't':
        out += '\t';
        break;
      case 'r':
        out += '\r';
        break;
      case 'b':
        out += '\b';
        break;
      case 'f':
        out += '\f';
        break;
      case '"':
        out += '"';
        break;
      case '\\':
        out += '\\';
        break;
      case 'u': {
        const hex = text.slice(i + 1, i + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new ConfigFileError(`${where}"\\u" needs four hex digits.`);
        out += String.fromCharCode(Number.parseInt(hex, 16));
        i += 4;
        break;
      }
      default:
        throw new ConfigFileError(`${where}"\\${escape ?? ''}" is not an escape this file may use.`);
    }
  }
  throw new ConfigFileError(`${where}a text value is not closed.`);
}

const INLINE_VALUE = /^(?:"(?:[^"\\]|\\.)*"|true|false|[+-]?\d+(?:\.\d+)?)$/;

function parseInlineTable(text: string, where: string): Record<string, FileValue> {
  if (!text.endsWith('}')) throw new ConfigFileError(`${where}a table ends with "}".`);
  const body = text.slice(1, -1).trim();
  const out: Record<string, FileValue> = {};
  if (!body) return out;
  for (const part of splitOutsideStrings(body, ',', where)) {
    const piece = part.trim();
    if (!piece) throw new ConfigFileError(`${where}a table has an empty entry.`);
    const eq = indexOutsideString(piece, '=');
    if (eq < 0) throw new ConfigFileError(`${where}a table entry is "key = value".`);
    const key = piece.slice(0, eq).trim();
    const raw = piece.slice(eq + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) throw new ConfigFileError(`${where}"${key}" is not a name this file may use.`);
    if (Object.prototype.hasOwnProperty.call(out, key)) throw new ConfigFileError(`${where}"${key}" is given twice.`);
    if (!INLINE_VALUE.test(raw)) throw new ConfigFileError(`${where}${key} needs text in quotes, true, false or a number.`);
    out[key] = parseValue(raw, where) as FileValue;
  }
  return out;
}

function splitOutsideStrings(text: string, separator: string, where: string): string[] {
  const parts: string[] = [];
  let inString = false;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === separator) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  if (inString) throw new ConfigFileError(`${where}a text value is not closed.`);
  parts.push(text.slice(start));
  return parts;
}

function stripComment(line: string): string {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '#') return line.slice(0, i);
  }
  return line;
}

function indexOutsideString(line: string, needle: string): number {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === needle) return i;
  }
  return -1;
}

// ------------------------------------------------------------------ check against the app

/**
 * Checks every name and value against the running app's allowlists (`GET /settings/catalog`).
 * Throws `ConfigFileError` naming the key; the command applies nothing when this throws.
 */
export function checkAgainst(doc: ConfigDoc, catalog: CatalogLike): void {
  const byKey = new Map(catalog.settings.map((entry) => [entry.key, entry]));
  const refused = new Set(catalog.refused ?? []);
  const labs = new Set(catalog.labs);

  for (const [key, value] of doc.settings) {
    if (!EXPORTABLE.has(key)) throw new ConfigFileError(`"${key}" is not a setting this file may change.`);
    if (refused.has(key) || looksSecret(key)) throw new ConfigFileError(`"${key}" cannot be read or changed from the command line.`);
    const entry = byKey.get(key);
    if (!entry) throw new ConfigFileError(`this app has no setting "${key}".`);
    if (!typeMatches(entry.type, value)) throw new ConfigFileError(`${key} takes a ${entry.type}, but the file says ${JSON.stringify(value)}.`);
  }
  for (const [key, value] of doc.labs) {
    if (typeof value !== 'boolean') throw new ConfigFileError(`${key} needs true or false.`);
    if (refused.has(key) || looksSecret(key) || !byKey.has(key)) throw new ConfigFileError(`this app has no Labs switch "${key}".`);
    if (!labs.has(key)) throw new ConfigFileError(`"${key}" is not a Labs switch in this app.`);
  }
  for (const section of ['default', 'helper_default'] as const) {
    const models = doc.models[section];
    if (models === undefined) continue;
    const setting = MODEL_KEYS[section];
    if (refused.has(setting) || !byKey.has(setting)) throw new ConfigFileError(`this app cannot set ${section} models.`);
  }
}

function typeMatches(type: string, value: FileValue): boolean {
  switch (type) {
    case 'boolean':
      return typeof value === 'boolean';
    case 'number':
      return typeof value === 'number';
    case 'string':
      return typeof value === 'string';
    case 'any':
      return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
    default:
      return false;
  }
}

// ------------------------------------------------------------------ plan ops

/** `{folder}` -> the open folder; otherwise a folder name that one open window has. */
export function resolveProject(label: string, openFolders: string[]): string | undefined {
  const clean = label.trim();
  if (clean === FOLDER) return openFolders[0];
  if (!clean) throw new ConfigFileError('a standby needs a project ("{folder}" or a project name).');
  // A hand-written file may name a folder outright.
  if (/^[A-Za-z]:[\\/]/.test(clean) || clean.startsWith('/') || clean.startsWith('\\\\')) return clean;
  const matches = openFolders.filter((folder) => lastSegment(folder).toLowerCase() === clean.toLowerCase());
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    throw new ConfigFileError(`the file names the project "${clean}", but no open window has that folder. Open it and run again.`);
  }
  throw new ConfigFileError(`more than one open folder is called "${clean}". Write the full folder path in the file.`);
}

function modelOf(helper: LiveStandby): string | null {
  return helper.model ?? null;
}

/**
 * The ops for `POST /config/plan`, built from the file and the current state. Settings that already
 * have the file's value are left out (so a round trip plans nothing). A standby that exists with a
 * different agent, model or "after" is closed and added again: the plan routes have no update op.
 */
export function planOps(doc: ConfigDoc, catalog: CatalogLike, standbys: LiveStandby[], openFolders: string[]): object[] {
  const ops: object[] = [];
  const byKey = new Map(catalog.settings.map((entry) => [entry.key, entry]));
  const patch: Record<string, unknown> = {};

  for (const [key, value] of doc.settings) {
    const saved = byKey.get(key)?.saved;
    if (!same(value, saved)) patch[key] = value;
  }
  for (const [key, value] of doc.labs) {
    const saved = byKey.get(key)?.saved;
    if (!same(value, saved)) patch[key] = value;
  }
  for (const section of ['default', 'helper_default'] as const) {
    const models = doc.models[section];
    if (models === undefined) continue;
    const setting = MODEL_KEYS[section];
    if (!same(models, byKey.get(setting)?.saved)) patch[setting] = models;
  }
  if (Object.keys(patch).length > 0) ops.push({ kind: 'settings', patch });

  const current = standbys.filter((helper) => !helper.warm);
  const byName = new Map(current.map((helper) => [helper.name.trim().toLowerCase(), helper]));
  const wanted = new Set<string>();
  for (const helper of doc.standby) {
    const name = helper.name.trim();
    const key = name.toLowerCase();
    wanted.add(key);
    const existing = byName.get(key);
    const project = resolveProject(helper.project, openFolders);
    const input: Record<string, unknown> = { kind: 'standby_add', name, agent: helper.agent };
    if (helper.model) input.model = helper.model;
    if (project) input.project = project;
    if (helper.after !== 'wait') input.after_task = helper.after;
    if (!existing) {
      ops.push(input);
      continue;
    }
    const projectChanged = helper.project !== FOLDER && project !== undefined && !sameFolder(project, existing.project);
    const changed =
      existing.agent.toLowerCase() !== helper.agent.toLowerCase() ||
      modelOf(existing) !== (helper.model ?? null) ||
      (existing.after_task === 'close' ? 'close' : 'wait') !== helper.after ||
      projectChanged;
    if (!changed) continue;
    if (existing.id) ops.push({ kind: 'standby_close', target: existing.id });
    ops.push(input);
  }
  for (const helper of current) {
    if (wanted.has(helper.name.trim().toLowerCase())) continue;
    if (helper.id) ops.push({ kind: 'standby_close', target: helper.id });
  }
  return ops;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}
