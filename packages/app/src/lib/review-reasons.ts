// The review desk's "why" sentences are written by the backend in English (`review_desk/risk.rs`). This turns the known
// ones into the app's language; a sentence it does not know is shown as it came. The draft that goes to the agent stays
// English on purpose (it is for the agent), so only what the person reads here is translated.
import { t } from '../i18n';
import type { ReviewReason } from './review-desk';

const MORE = / and (\d+) more$/;
/** `a, b and 3 more` -> the names part and the localized tail. */
function names(list: string): string {
  const m = MORE.exec(list);
  return m ? `${list.slice(0, m.index)}${t('r12ui.reason.more', { n: m[1] })}` : list;
}

const LISTED: ReadonlyArray<[string, string]> = [
  ['A file may hold a secret: ', 'r12ui.reason.secretFile'],
  ['A line looks like a secret: ', 'r12ui.reason.secretLine'],
  ['CI files changed: ', 'r12ui.reason.ci'],
  ['A line has your home folder: ', 'r12ui.reason.home'],
  ['Test files changed: ', 'r12ui.reason.tests'],
  ['Check settings changed: ', 'r12ui.reason.settings'],
  ['A package list changed: ', 'r12ui.reason.packages'],
  ['The tests were weakened: ', 'r12ui.reason.weakened'],
];

export function reasonText(reason: Pick<ReviewReason, 'sentence'>): string {
  const s = reason.sentence;
  for (const [prefix, key] of LISTED) {
    if (s.startsWith(prefix)) return t(key as 'r12ui.reason.tests', { list: names(s.slice(prefix.length)) });
  }
  const big = /^Big change: ([\d,]+) files, \+([\d,]+) \u2212([\d,]+)$/.exec(s);
  if (big) return t('r12ui.reason.big', { files: big[1], added: big[2], deleted: big[3] });
  const checks = /^Checks failed: ([\d,]+) of ([\d,]+) passed(?: \((.*)\))?$/.exec(s);
  if (checks) return t('r12ui.reason.checks', { passed: checks[1], total: checks[2], failed: checks[3] ? ` (${names(checks[3])})` : '' });
  if (s === 'Potato Workspace could not see which files changed') return t('r12ui.reason.unknown');
  return s;
}
