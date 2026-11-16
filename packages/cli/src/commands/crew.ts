/**
 * `crew list|show ID|validate FILE` (read-only).
 *
 * Nothing here changes the app: `crew list` and `crew show` read `GET /crews` and `GET /crews/{id}`, and
 * `crew validate FILE` reads the file on this computer and sends its text to `POST /crews/validate`, which
 * checks it and saves nothing. Applying a crew comes with the crew canvas (1.1.7).
 *
 * The file may be one crew (`name` and `[[roles]]`) or a config file with `[crew.<id>]` sections. Exit 0 when
 * every crew passes, 1 when a crew has a problem or the file cannot be read.
 */
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { CliError, EXIT, type Bridge } from '../bridge.js';
import type { ConfigArgs } from '../args.js';
import { table, type Io } from '../output.js';

interface Ctx {
  bridge: Bridge;
  io: Io;
  args: ConfigArgs;
}

interface Summary {
  slug: string;
  name: string;
  roles: number;
  agents: string[];
  problem: string | null;
}

interface Problem {
  code: string;
  role?: string | null;
  message: string;
}

interface Permissions {
  read?: boolean;
  write?: string;
  write_scope?: string | null;
  run?: string;
  start_helpers?: boolean;
  merge?: boolean;
}

interface Role {
  id?: string;
  name: string;
  agent_type: string;
  model?: string | null;
  parent?: string | null;
  permissions?: Permissions | null;
  standbys?: number;
  hands_to?: string[];
  check?: boolean;
}

interface CrewView {
  id: string;
  kind: 'saved' | 'template';
  crew: {
    name: string;
    roles: Role[];
    budget?: { turns?: number; minutes?: number } | null;
    max_helpers?: number | null;
    fix_loops?: number | null;
    routing_file?: string | null;
  };
  problems: Problem[];
  routing_text?: string | null;
}

interface Checked {
  ok: boolean;
  kind: string;
  crews: Array<{ id: string; name: string; roles: number; problems: Problem[] }>;
  problems: Problem[];
}

const USAGE = 'usage: potato-workspace crew list | show ID | validate FILE';
/** The app reads at most 64 KB of a crew file; no reason to send a bigger one. */
const MAX_FILE_BYTES = 64 * 1024;

export async function runCrew(ctx: Ctx): Promise<number> {
  const [sub, target, ...extra] = ctx.args.positional;
  if (extra.length > 0) throw new CliError(EXIT.failed, USAGE);
  switch (sub) {
    case 'list':
      if (target !== undefined) throw new CliError(EXIT.failed, USAGE);
      return list(ctx);
    case 'show':
      if (!target) throw new CliError(EXIT.failed, USAGE);
      return show(ctx, target);
    case 'validate':
      if (!target) throw new CliError(EXIT.failed, USAGE);
      return validate(ctx, target);
    default:
      throw new CliError(EXIT.failed, USAGE);
  }
}

async function list({ bridge, io, args }: Ctx): Promise<number> {
  const view = await bridge.get<{ crews?: Summary[]; templates?: Summary[] }>('/crews');
  const crews = view.crews ?? [];
  const templates = view.templates ?? [];
  if (args.json) {
    io.out(JSON.stringify({ crews, templates }));
    return EXIT.ok;
  }
  const row = (kind: string, s: Summary) => [s.slug, kind, s.name, String(s.roles), s.agents.join(', '), s.problem ? `problem: ${s.problem}` : 'ok'];
  const rows = [['ID', 'KIND', 'NAME', 'ROLES', 'AGENTS', 'STATUS'], ...crews.map((s) => row('saved', s)), ...templates.map((s) => row('template', s))];
  for (const line of table(rows)) io.out(line);
  if (crews.length === 0) io.out('No saved crews yet. The template can be read with: potato-workspace crew show template:our-way');
  return EXIT.ok;
}

function permissionWords(p: Permissions | null | undefined): string {
  if (!p) return '-';
  const parts = [p.read === false ? 'no read' : 'read'];
  parts.push(p.write && p.write !== 'none' ? `write ${p.write === 'scoped' ? `in ${p.write_scope ?? '?'}` : p.write}` : 'no write');
  parts.push(p.run && p.run !== 'none' ? `run ${p.run}` : 'no run');
  if (p.start_helpers) parts.push('starts helpers');
  if (p.merge) parts.push('merges');
  return parts.join(', ');
}

function problemLines(problems: Problem[], indent = ''): string[] {
  return problems.map((p) => `${indent}- ${p.code}${p.role ? ` (${p.role})` : ''}: ${p.message}`);
}

async function show({ bridge, io, args }: Ctx, id: string): Promise<number> {
  const view = await bridge.get<CrewView>(`/crews/${encodeURIComponent(id).replace(/%3A/gi, ':')}`);
  if (args.json) {
    io.out(JSON.stringify(view));
    return EXIT.ok;
  }
  const { crew } = view;
  io.out(`${crew.name} (${view.kind === 'template' ? 'template, read-only' : 'saved crew'})`);
  if (crew.routing_file) io.out(`routing file: ${crew.routing_file}`);
  if (crew.budget) io.out(`budget: ${[crew.budget.turns != null ? `${crew.budget.turns} turns` : '', crew.budget.minutes != null ? `${crew.budget.minutes} minutes` : ''].filter(Boolean).join(', ')}`);
  if (crew.max_helpers != null) io.out(`most helpers at once: ${crew.max_helpers}`);
  if (crew.fix_loops != null) io.out(`most fix loops: ${crew.fix_loops}`);
  const rows = [
    ['ROLE', 'AGENT', 'MODEL', 'UNDER', 'WARM', 'HANDS TO', 'MAY'],
    ...crew.roles.map((r) => [
      r.id || r.name,
      r.agent_type,
      r.model ?? '-',
      r.parent ?? '-',
      String(r.standbys ?? 0),
      [...(r.hands_to ?? [])].join(', ') || '-',
      permissionWords(r.permissions),
    ]),
  ];
  for (const line of table(rows)) io.out(line);
  if (view.problems.length === 0) io.out('problems: none');
  else {
    io.out('problems:');
    for (const line of problemLines(view.problems, '  ')) io.out(line);
  }
  return EXIT.ok;
}

async function validate({ bridge, io, args }: Ctx, file: string): Promise<number> {
  const path = resolve(file);
  let text: string;
  try {
    if (statSync(path).size > MAX_FILE_BYTES) throw new CliError(EXIT.failed, `${file} is too big to be a crew file (the limit is 64 KB).`);
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError(EXIT.failed, `Cannot read ${file}: ${(err as NodeJS.ErrnoException).code === 'ENOENT' ? 'no such file' : (err as Error).message}`);
  }
  const result = await bridge.post<Checked>('/crews/validate', { text });
  if (args.json) {
    io.out(JSON.stringify(result));
    return result.ok ? EXIT.ok : EXIT.failed;
  }
  for (const crew of result.crews) {
    io.out(`${crew.id}: ${crew.name || '(no name)'}, ${crew.roles} roles, ${crew.problems.length === 0 ? 'ok' : `${crew.problems.length} problem${crew.problems.length === 1 ? '' : 's'}`}`);
    for (const line of problemLines(crew.problems, '  ')) io.out(line);
  }
  for (const line of problemLines(result.problems)) io.out(line);
  io.out(result.ok ? 'This crew file is fine. Nothing was changed.' : 'This crew file has problems. Nothing was changed.');
  return result.ok ? EXIT.ok : EXIT.failed;
}
