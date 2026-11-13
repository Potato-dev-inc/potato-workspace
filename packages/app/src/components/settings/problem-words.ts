// How a list of setup checks reads in a few words. Used by the Overview card AND the Setup list header, so both
// always say the same thing: a cross is "a fix", a "!" is "to check".
import type { CheckRow } from '../../lib/setup-checks';

export function countProblems(rows: CheckRow[]): { fix: number; check: number } {
  return { fix: rows.filter((r) => r.status === 'fail').length, check: rows.filter((r) => r.status === 'warn').length };
}

/** "2 things need a fix, 2 to check", "1 thing needs a fix", "3 to check"; null when nothing is wrong. */
export function problemWords(rows: CheckRow[]): string | null {
  const { fix, check } = countProblems(rows);
  const parts: string[] = [];
  if (fix > 0) parts.push(`${fix} ${fix === 1 ? 'thing needs' : 'things need'} a fix`);
  if (check > 0) parts.push(`${check} to check`);
  return parts.length > 0 ? parts.join(', ') : null;
}
