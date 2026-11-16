/**
 * Plan, show, then apply: shared by every changing command (`standby ...`, `config import`).
 *
 * `POST /config/plan` changes nothing and returns the plain lines plus a plan id; `POST
 * /config/apply` runs exactly that plan. Nothing is applied without `--yes` (or a y at a terminal).
 * `--dry-run` never applies. From an agent's window the apply raises the person's Allow card in the
 * app; `bridge.ts` waits for the answer and repeats the same call.
 */
import { EXIT, type Bridge } from '../bridge.js';
import type { ConfigArgs } from '../args.js';
import type { Io } from '../output.js';

export interface PlanContext {
  bridge: Bridge;
  io: Io;
  args: ConfigArgs;
}

export interface PlanReply {
  plan_id: string;
  lines: string[];
  changes_anything?: boolean;
}

export interface ApplyReply {
  applied: boolean;
  lines: string[];
  standby_added?: Array<{ id: string; name: string }>;
}

/** The plan for these ops, with nothing changed. */
export async function makePlan(ctx: PlanContext, ops: unknown[]): Promise<PlanReply> {
  return ctx.bridge.post<PlanReply>('/config/plan', { ops });
}

export async function planAndApply(ctx: PlanContext, ops: unknown[]): Promise<number> {
  const { bridge, io, args } = ctx;
  const plan = await makePlan(ctx, ops);
  if (!args.json) for (const line of plan.lines) io.out(line);
  if (plan.changes_anything === false) {
    if (args.json) io.out(JSON.stringify({ plan, applied: false, reason: 'no change' }));
    else io.out('Nothing to change.');
    return EXIT.ok;
  }
  if (args.dryRun) {
    if (args.json) io.out(JSON.stringify({ plan, applied: false, reason: 'dry run' }));
    else io.out('Dry run: nothing was changed.');
    return EXIT.ok;
  }
  if (!args.yes) {
    if (io.interactive && !args.json) {
      if (!(await io.confirm('Apply this? [y/N] '))) {
        io.out('Nothing was changed.');
        return EXIT.needsConfirmation;
      }
    } else {
      if (args.json) io.out(JSON.stringify({ plan, applied: false, reason: 'needs --yes' }));
      io.err('Nothing was changed. Run the same command again with --yes to apply it.');
      return EXIT.needsConfirmation;
    }
  }
  const done = await bridge.post<ApplyReply>('/config/apply', { plan_id: plan.plan_id });
  if (args.json) {
    io.out(JSON.stringify({ plan, applied: done.applied, standby_added: done.standby_added ?? [] }));
  } else {
    io.out('Done.');
  }
  return EXIT.ok;
}
