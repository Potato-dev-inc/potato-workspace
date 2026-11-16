// Pure helpers of "Change the crew by talking": which lines of the canvas a proposal touches, and which rule lines it adds or
// takes out. Nothing here calls the app, so it is tested alone (talkModel.test.ts).
import type { Crew } from '../../lib/crews-api';
import type { TalkChange } from '../../lib/crew-talk-api';
import { findRole } from './model';

export type TalkView = 'before' | 'after';

/** The lines (`from>to` role keys) a proposal changes: the ones taken away show on "before", the ones added on "after". */
export function changedEdges(changes: TalkChange[], view: TalkView): string[] {
  const kind = view === 'before' ? 'handoff_removed' : 'handoff_added';
  return changes.flatMap((c) => (c.kind === kind ? [`${c.from}>${c.to}`] : []));
}

/** The roles whose routing rules change. */
export function touchedRoles(changes: TalkChange[]): string[] {
  return [...new Set(changes.flatMap((c) => (c.kind === 'rule_added' || c.kind === 'rule_removed' ? [c.role] : [])))];
}

/** The rule lines the new rules add and the ones they take out (compared line by line, blanks left out). */
export function ruleLines(before: string, after: string): { added: string[]; removed: string[] } {
  const lines = (text: string) => text.split('\n').map((l) => l.trim()).filter(Boolean);
  const [b, a] = [lines(before), lines(after)];
  return { added: a.filter((l) => !b.includes(l)), removed: b.filter((l) => !a.includes(l)) };
}

/** The role's name for a key in a crew (the key itself when it is not found). */
export const roleName = (crew: Crew, key: string): string => findRole(crew, key)?.name ?? key;

/** Same crew and rules, as the canvas holds them. */
export const sameState = (a: { crew: Crew; rules: string }, b: { crew: Crew; rules: string }): boolean => JSON.stringify([a.crew, a.rules]) === JSON.stringify([b.crew, b.rules]);
