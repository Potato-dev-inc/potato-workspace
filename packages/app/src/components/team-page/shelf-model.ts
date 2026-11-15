// The Shelf tab's pure rules: the filter, the "who has this" line and what the Add sheet is about.
import { t } from '../../i18n';
import type { CardView, Recommended, ShelfKind, ShelfTarget, WriteStatus } from '../../lib/shelf';

export type ShelfFilter = 'all' | 'skills' | 'tools';
export const SHELF_FILTERS: readonly ShelfFilter[] = ['all', 'skills', 'tools'];

export function kindMatches(kind: ShelfKind, filter: ShelfFilter): boolean {
  if (filter === 'all') return true;
  return filter === 'skills' ? kind === 'skill' : kind === 'tool';
}

/** What the Add sheet needs to know about a suggestion, whether it came from "Suggested to you" or "Team recommends". */
export interface AddSubject {
  cardId: string;
  id: string;
  kind: ShelfKind;
  name: string;
  byName: string;
}

export const subjectOfCard = (c: CardView): AddSubject => ({ cardId: c.cardId, id: c.id, kind: c.kind, name: c.name, byName: c.byName });
export const subjectOfRecommended = (r: Recommended): AddSubject => ({ cardId: r.cardId, id: r.id, kind: r.kind, name: r.name, byName: r.byNames.join(', ') });

/** Up to three names are listed; more than that reads as a count. */
const NAMES_MAX = 3;

/** "Maya, Leo have it" / "4 of 5 have it" / nothing to say. `mine`: the list leaves me out, so I am counted on top. */
export function whoHasLine(have: readonly string[], teamSize: number, mine: boolean): string | null {
  if (have.length === 0) return mine ? t('teamHub.shelf.onlyYou') : t('teamHub.shelf.nobodyHas');
  if (have.length <= NAMES_MAX) return t(mine ? 'teamHub.shelf.haveTooNames' : 'teamHub.shelf.haveNames', { names: have.join(', '), count: have.length });
  return t('teamHub.shelf.haveCount', { n: have.length + (mine ? 1 : 0), size: Math.max(teamSize, have.length + 1) });
}

/** Skills go to agents that can hold skills, tools to agents that can hold tools. Installed agents come first. */
export function targetsFor(kind: ShelfKind, targets: readonly ShelfTarget[]): ShelfTarget[] {
  const ok = targets.filter((x) => (kind === 'skill' ? x.skills : kind === 'tool' ? x.tools : false));
  return [...ok.filter((x) => x.installed), ...ok.filter((x) => !x.installed)];
}

export const defaultAgents = (list: readonly ShelfTarget[]): string[] => list.filter((x) => x.installed).map((x) => x.id);

/** "Claude Code", "Claude Code and Codex", "A, B and C". */
export function listWords(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  const and = t('teamHub.shelf.and');
  return `${items.slice(0, -1).join(', ')}${and}${items[items.length - 1]}`;
}

export function statusWords(status: WriteStatus): string {
  switch (status) {
    case 'add':
      return t('teamHub.shelf.status.add');
    case 'unchanged':
      return t('teamHub.shelf.status.unchanged');
    case 'conflict':
      return t('teamHub.shelf.status.conflict');
    case 'skipped':
      return t('teamHub.shelf.status.skipped');
    default:
      return t('teamHub.shelf.status.error');
  }
}
