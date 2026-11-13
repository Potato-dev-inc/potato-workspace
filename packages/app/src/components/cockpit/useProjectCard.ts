// What a project card in the sidebar knows beyond its agents: each top-level agent's git branch and, for a separate
// copy, the copy's change counts and pull request. It reuses the two lookups the Changes panel already makes
// (paneGitBranch, paneWorktree) and asks again for an agent only when that agent's status changes: never per row
// per tick, so the sidebar adds no git work while agents just run.
import { useEffect, useRef, useState } from 'react';
import { cockpitApi, type WorktreeItem } from '../../lib/cockpit-api';

export interface PaneCard {
  branch: string | null;
  /** The separate copy the agent works in, if it works in one. */
  copy: WorktreeItem | null;
}

export type CardApi = Pick<typeof cockpitApi, 'paneGitBranch' | 'paneWorktree'>;

/** One entry per pane id. `key` changes when the pane's status does. */
export function usePaneCards(panes: readonly { id: string; status: string }[], api: CardApi = cockpitApi): ReadonlyMap<string, PaneCard> {
  const [cards, setCards] = useState<ReadonlyMap<string, PaneCard>>(new Map());
  const asked = useRef(new Map<string, string>());
  const sig = panes.map((p) => `${p.id}:${p.status}`).join('|');
  useEffect(() => {
    let live = true;
    const gone = new Set(panes.map((p) => p.id));
    for (const id of [...asked.current.keys()]) if (!gone.has(id)) asked.current.delete(id);
    for (const { id, status } of panes) {
      if (asked.current.get(id) === status) continue;
      asked.current.set(id, status);
      Promise.all([api.paneGitBranch(id).catch(() => null), api.paneWorktree(id).catch(() => null)]).then(([branch, wt]) => {
        if (!live) return;
        setCards((prev) => {
          const next = new Map(prev);
          next.set(id, { branch: branch ?? null, copy: wt && wt.exists ? wt : null });
          return next;
        });
      });
    }
    return () => {
      live = false;
    };
  }, [sig, api]); // eslint-disable-line react-hooks/exhaustive-deps
  return cards;
}

export interface BranchGroup<T> {
  key: string;
  /** The branch name, or the copy's. */
  label: string;
  /** A separate copy of the project, not the project folder itself. */
  copy: boolean;
  /** `PR #212`, and how its checks are going, when the app already knows the pull request. */
  pr: string | null;
  items: T[];
}

const checksText = (state: string | undefined): string | null =>
  state === 'passing' ? 'checks pass' : state === 'failing' ? 'checks failing' : state === 'pending' ? 'checks running' : null;

export function prLine(copy: WorktreeItem | null): string | null {
  const pr = copy?.pr;
  if (!pr) return null;
  const checks = checksText(pr.checks?.state);
  return checks ? `PR #${pr.number} · ${checks}` : `PR #${pr.number}`;
}

/** The agents of one project, grouped by branch and copy. Returns null when one plain branch covers them all: the
 *  card then names that branch once on its second line instead of repeating it. */
export function groupByBranch<T>(items: readonly T[], idOf: (item: T) => string, cards: ReadonlyMap<string, PaneCard>): BranchGroup<T>[] | null {
  const groups = new Map<string, BranchGroup<T>>();
  for (const item of items) {
    const card = cards.get(idOf(item));
    const copy = card?.copy ?? null;
    const key = copy ? `copy:${copy.handle}` : `branch:${card?.branch ?? ''}`;
    const g = groups.get(key) ?? { key, label: copy?.branch ?? card?.branch ?? '', copy: copy !== null, pr: prLine(copy), items: [] };
    g.items.push(item);
    groups.set(key, g);
  }
  const all = [...groups.values()];
  if (all.length <= 1 && !all[0]?.copy) return null;
  return all;
}

/** The card's headline numbers: lines added and removed across the project's separate copies. null: nothing to show. */
export function projectChanges(ids: readonly string[], cards: ReadonlyMap<string, PaneCard>): { additions: number; deletions: number } | null {
  const seen = new Set<string>();
  let additions = 0;
  let deletions = 0;
  for (const id of ids) {
    const copy = cards.get(id)?.copy;
    if (!copy?.summary || seen.has(copy.handle)) continue;
    seen.add(copy.handle);
    additions += copy.summary.additions;
    deletions += copy.summary.deletions;
  }
  return additions + deletions > 0 ? { additions, deletions } : null;
}

/** The branch of the project folder itself (the first agent that works there, not in a copy). */
export function primaryBranch(ids: readonly string[], cards: ReadonlyMap<string, PaneCard>): string | null {
  for (const id of ids) {
    const c = cards.get(id);
    if (c && !c.copy && c.branch) return c.branch;
  }
  return null;
}
