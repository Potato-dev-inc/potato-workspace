/**
 * Read-only commands: `status`, `agents list`, `models list AGENT`, `projects list`.
 * They never change anything, so an agent's shell needs no Allow card for them.
 */
import { readBridgePort } from '@potato-workspace/shared/bridge-port';
import { CliError, EXIT, type Bridge } from '../bridge.js';
import type { ConfigArgs } from '../args.js';
import { isKeyName } from '../args.js';
import { table, type Io } from '../output.js';

interface Ctx {
  bridge: Bridge;
  io: Io;
  args: ConfigArgs;
  /** The CLI's own version, for `status`. */
  cliVersion: string;
}

interface Health {
  ok?: boolean;
  version?: string;
  build_id?: string;
  build_kind?: string;
  profile?: string;
  tool_count?: number;
  catalog_hash?: string;
}

export async function runStatus(ctx: Ctx): Promise<number> {
  const { bridge, io, args, cliVersion } = ctx;
  const health = await bridge.get<Health>('/health');
  const { port } = await readBridgePort().catch(() => ({ port: 0 }));
  const view = {
    running: health.ok === true,
    app_version: health.version ?? null,
    build_id: health.build_id ?? null,
    build_kind: health.build_kind ?? null,
    profile: health.profile ?? null,
    tool_count: health.tool_count ?? null,
    catalog_hash: health.catalog_hash ?? null,
    bridge_port: port || null,
    cli_version: cliVersion,
  };
  if (args.json) {
    io.out(JSON.stringify(view));
    return EXIT.ok;
  }
  io.out(`app: running, version ${view.app_version ?? '?'} (${view.build_kind ?? 'unknown build'})`);
  if (view.profile) io.out(`profile: ${view.profile}`);
  io.out(`bridge port: ${view.bridge_port ?? '?'}`);
  io.out(`tools: ${view.tool_count ?? '?'}`);
  io.out(`cli version: ${cliVersion}`);
  return EXIT.ok;
}

interface AgentRow {
  id: string;
  label?: string;
  installed?: boolean;
  dispatchable?: boolean;
  experimental?: boolean;
  kind?: string;
  source?: string;
}

export async function runAgents(ctx: Ctx): Promise<number> {
  const { bridge, io, args } = ctx;
  if (args.positional[0] !== 'list' || args.positional.length !== 1) {
    throw new CliError(EXIT.failed, 'usage: potato-workspace agents list');
  }
  const listing = await bridge.get<{ agents?: AgentRow[] }>('/agents/types');
  // Only the summary: the definition block can carry paths and launch settings, which a listing does not need.
  const agents = (listing.agents ?? []).map((a) => ({
    id: a.id,
    name: a.label ?? a.id,
    installed: a.installed === true,
    dispatchable: a.dispatchable === true,
    experimental: a.experimental === true,
    source: a.source ?? null,
  }));
  if (args.json) {
    io.out(JSON.stringify(agents));
    return EXIT.ok;
  }
  const rows = [
    ['ID', 'NAME', 'INSTALLED', 'CAN RUN'],
    ...agents.map((a) => [a.id, a.name, a.installed ? 'yes' : 'no', a.dispatchable ? 'yes' : 'no']),
  ];
  for (const line of table(rows)) io.out(line);
  return EXIT.ok;
}

export async function runModels(ctx: Ctx): Promise<number> {
  const { bridge, io, args } = ctx;
  const [sub, agent] = args.positional;
  if (sub !== 'list' || !agent || args.positional.length !== 2 || !isKeyName(agent.replace(/-/g, '_'))) {
    throw new CliError(EXIT.failed, 'usage: potato-workspace models list AGENT');
  }
  const options = await bridge.get<{ default_model?: string | null; models?: string[]; live_failed?: boolean }>(
    `/phone/new-chat/models?agent=${encodeURIComponent(agent)}`,
  );
  const models = options.models ?? [];
  if (args.json) {
    io.out(JSON.stringify({ agent, default_model: options.default_model ?? null, models, live_failed: options.live_failed === true }));
    return EXIT.ok;
  }
  if (options.default_model) io.out(`default: ${options.default_model}`);
  for (const model of models) io.out(model);
  if (models.length === 0) io.out('This agent did not list models. You can still type a model id.');
  if (options.live_failed) io.err('The agent could not be asked for its models just now; this list may be short.');
  return EXIT.ok;
}

interface Pane {
  cwd?: string | null;
  killed?: boolean;
}

/** Folders that have an open window now. The app has no route for the saved project list yet. */
export async function runProjects(ctx: Ctx): Promise<number> {
  const { bridge, io, args } = ctx;
  if (args.positional[0] !== 'list' || args.positional.length !== 1) {
    throw new CliError(EXIT.failed, 'usage: potato-workspace projects list');
  }
  const state = await bridge.get<{ panes?: Pane[] }>('/workspace/state');
  const counts = new Map<string, number>();
  for (const pane of state.panes ?? []) {
    if (pane.killed || !pane.cwd) continue;
    counts.set(pane.cwd, (counts.get(pane.cwd) ?? 0) + 1);
  }
  const projects = [...counts.entries()].map(([path, windows]) => ({ path, windows }));
  if (args.json) {
    io.out(JSON.stringify(projects));
    return EXIT.ok;
  }
  if (projects.length === 0) io.out('No folder has an open window.');
  for (const line of table(projects.map((p) => [String(p.windows), p.path]))) io.out(line);
  return EXIT.ok;
}
