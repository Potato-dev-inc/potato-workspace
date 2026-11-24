// The one-line turn sentence comes from the backend in English ("Claude edited 3 files (+48 −7), all checks passed (3/3), now idle.").
// Show it in the person's language by turning each known part back into words; a part this does not know stays as it came.
import { formatElapsed } from '../components/cockpit/model';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the keys are built from the sentence parts
type T = (key: any, vars?: Record<string, string | number>) => string;

const ms = (d: string): number => {
  const [, h, m, s] = /^(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?$/.exec(d) ?? [];
  return ((+h || 0) * 3600 + (+m || 0) * 60 + (+s || 0)) * 1000;
};

function part(t: T, p: string, reviewFiles?: number | null): string {
  let m: RegExpExecArray | null;
  if ((m = /^(.+?) edited (\d+) files? \((\+\d+) (\S+)\)$/.exec(p))) return t('r10.turn.edited', { agent: m[1], count: +m[2], add: m[3], del: m[4] });
  // The review of the turn (the file list under it) is the one source for files: "made no file changes" never sits above a list of files.
  if ((m = /^(.+?) made no file changes$/.exec(p))) return reviewFiles && reviewFiles > 0 ? t('r10.turn.changed', { agent: m[1], count: reviewFiles }) : t('r10.turn.noFiles', { agent: m[1] });
  if ((m = /^(.+?) worked for (.+)$/.exec(p))) return t('r10.turn.worked', { agent: m[1], time: formatElapsed(ms(m[2])) });
  if ((m = /^you (approved|declined) (\d+) (command|request)s?$/.exec(p))) return t(`r10.turn.${m[1]}.${m[3]}`, { count: +m[2] });
  if ((m = /^all checks passed(?: \((.+)\))?$/.exec(p))) return m[1] ? t('r10.turn.checksPassed', { n: m[1] }) : t('r10.turn.checksPassedAll');
  if ((m = /^checks failed(?: \((.+) passed\))?$/.exec(p))) return m[1] ? t('r10.turn.checksFailed', { n: m[1] }) : t('r10.turn.checksFailedAll');
  const fixed: Record<string, string> = {
    'no checks ran': 'r10.turn.noChecks',
    'the run failed': 'r10.turn.runFailed',
    'the run was cancelled': 'r10.turn.runCancelled',
    'ended with an error': 'r10.turn.endedError',
    'now idle': 'r10.turn.idle',
    'now waiting for you': 'r10.turn.waitingYou',
  };
  return fixed[p] ? t(fixed[p]) : p;
}

export function turnSentence(t: T, sentence: string, reviewFiles?: number | null): string {
  const at = sentence.indexOf(', now waiting: ');
  const prompt = at >= 0 ? sentence.slice(at + ', now waiting: '.length) : '';
  const head = at >= 0 ? sentence.slice(0, at) : sentence.replace(/\.$/, '');
  const parts = head.split(', ').map((p) => part(t, p, reviewFiles));
  if (at >= 0) parts.push(t('r10.turn.waitingOn', { prompt }));
  const line = parts.join(t('r10.turn.join'));
  return /[?.。？]$/.test(line) ? line : line + t('r10.turn.end');
}

/** A Review title is the turn sentence only for a finished turn; a title the agent wrote is shown as it came. */
const BRANCH_LINE = 'Branch: you are starting a new line of work from an earlier point in a chat.';

export function turnTitle(t: T, title: string): string {
  // A branch chat starts from a brief whose first line the backend writes in English; its title would say so in every language.
  if (title.startsWith(BRANCH_LINE)) return t('r23ui.branch.title') + title.slice(BRANCH_LINE.length);
  return /, now (idle|waiting)|^\S.* (edited \d+ files?|made no file changes|worked for)\b/.test(title) ? turnSentence(t, title) : title;
}
