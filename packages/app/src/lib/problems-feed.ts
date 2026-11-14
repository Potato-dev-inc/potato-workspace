// Where the Problems list gets its rows: the "Needs you" list (an agent that stopped with an error, a stuck agent) and the usage
// strip (a sign-in that ended). Each feed owns an id prefix; a row of that prefix that is no longer reported is marked fixed.
import { useEffect, useRef } from 'react';
import { t } from '../i18n';
import type { NeedsYouItem } from './attention';
import { fixProblem, openProblems, problemsSnapshot, reportProblem, type ProblemInput } from './problems';
import type { UsageRow } from './usage';

export interface NeedsFeedContext {
  /** The pane's own name in the sidebar ("Claude"). */
  nameOf: (paneId: string) => string;
  agentIdOf: (paneId: string) => string | null;
}

/** The problems the Needs-you list shows now. Pure. */
export function problemsFromNeeds(items: readonly NeedsYouItem[], ctx: NeedsFeedContext): ProblemInput[] {
  const out: ProblemInput[] = [];
  for (const item of items) {
    if ((item.kind !== 'error' && item.kind !== 'stuck') || !item.paneId) continue;
    const agent = ctx.nameOf(item.paneId);
    out.push({
      id: `${item.kind}:${item.paneId}`,
      what: t(item.kind === 'error' ? 'flow.problems.stopped' : 'flow.problems.stuck', { agent }),
      agent,
      agentId: ctx.agentIdOf(item.paneId),
      paneId: item.paneId,
      way: 'open_chat',
      at: item.since,
    });
  }
  return out;
}

/** One problem per sign-in that ended. Pure. */
export function problemsFromUsage(rows: readonly UsageRow[]): ProblemInput[] {
  return rows
    .filter((r) => r.state === 'expired')
    .map((r) => {
      const agent = r.account_label ? `${r.label} (${r.account_label})` : r.label;
      return { id: `signin:${r.agent_id}:${r.account_id ?? ''}`, what: t('flow.problems.signedOut', { agent }), agent, agentId: r.agent_id, paneId: null, way: 'sign_in' as const };
    });
}

/** Reports `current` and marks every open row of `prefix` that is not in it as fixed. */
export function syncProblems(prefix: string, current: readonly ProblemInput[]): void {
  const ids = new Set(current.map((p) => p.id));
  for (const p of current) reportProblem(p);
  for (const p of openProblems(problemsSnapshot())) if (p.id.startsWith(prefix) && !ids.has(p.id)) fixProblem(p.id);
}

/** In the cockpit: keeps the "error:" and "stuck:" rows in step with the Needs-you list. */
export function useNeedsProblemFeed(items: readonly NeedsYouItem[], ctx: NeedsFeedContext): void {
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  // The list is rebuilt on every render; what matters is which pane has which kind.
  const key = items.map((i) => `${i.kind}:${i.paneId ?? ''}`).join('|');
  useEffect(() => {
    const current = problemsFromNeeds(itemsRef.current, ctxRef.current);
    syncProblems('error:', current.filter((p) => p.id.startsWith('error:')));
    syncProblems('stuck:', current.filter((p) => p.id.startsWith('stuck:')));
  }, [key]);
}
