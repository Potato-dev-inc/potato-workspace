/**
 * `standby list|add|remove|close`.
 *
 * Reading is `GET /config/standby`. A change is PLAN then APPLY: `POST /config/plan` returns the plain lines of what would
 * change (nothing is touched), then `POST /config/apply` runs exactly that plan by its id. From an agent's window the apply
 * raises an Allow card for the person (the bridge's shell gate); the CLI waits for the answer (see `bridge.ts`).
 *
 * Words: "remove" only takes a standby off its agent (it keeps running as a free warm agent); "close" stops it.
 */
import { CliError, EXIT, type Bridge } from '../bridge.js';
import type { ConfigArgs } from '../args.js';
import { table, type Io } from '../output.js';
import { planAndApply } from './plan.js';

interface Ctx {
  bridge: Bridge;
  io: Io;
  args: ConfigArgs;
}

interface HelperEntry {
  id: string;
  name: string;
  agent: string;
  model?: string | null;
  project?: string;
  after_task?: string;
  state?: string;
  warm?: boolean;
  note?: string | null;
}

interface HelpersView {
  helpers: HelperEntry[];
  max?: number;
  idle_minutes?: number;
}

const USAGE =
  'usage: potato-workspace standby list | add --name N --agent A [--model M] [--project P] [--after wait|close] | remove NAME | close NAME';

function oneName(args: ConfigArgs, rest: string[], verb: string): string {
  if (rest.length !== 1) throw new CliError(EXIT.failed, `usage: potato-workspace standby ${verb} NAME`);
  return rest[0];
}

export async function runStandby(ctx: Ctx): Promise<number> {
  const { bridge, io, args } = ctx;
  const [sub, ...rest] = args.positional;
  switch (sub) {
    case 'list': {
      const view = await bridge.get<HelpersView>('/config/standby');
      if (args.json) {
        io.out(JSON.stringify(view));
        return EXIT.ok;
      }
      if (view.helpers.length === 0) {
        io.out('No standbys.');
        return EXIT.ok;
      }
      const rows = [
        ['NAME', 'AGENT', 'MODEL', 'STATE', 'AFTER TASK', 'ID'],
        ...view.helpers.map((h) => [
          h.name,
          h.agent,
          h.model ?? '(agent default)',
          h.warm ? `${h.state ?? '?'} (free warm agent)` : (h.state ?? '?'),
          h.after_task ?? 'wait',
          h.id,
        ]),
      ];
      for (const line of table(rows)) io.out(line);
      return EXIT.ok;
    }
    case 'add': {
      if (rest.length > 0) throw new CliError(EXIT.failed, USAGE);
      const { name, agent, model, project, after } = args.values;
      if (!name || !agent) throw new CliError(EXIT.failed, `standby add needs --name and --agent. ${USAGE}`);
      const op: Record<string, unknown> = { kind: 'standby_add', name, agent };
      if (model) op.model = model;
      if (project) op.project = project;
      if (after) op.after_task = after;
      return planAndApply(ctx, [op]);
    }
    case 'remove':
      return planAndApply(ctx, [{ kind: 'standby_remove', target: oneName(args, rest, 'remove') }]);
    case 'close':
      return planAndApply(ctx, [{ kind: 'standby_close', target: oneName(args, rest, 'close') }]);
    default:
      throw new CliError(EXIT.failed, USAGE);
  }
}
