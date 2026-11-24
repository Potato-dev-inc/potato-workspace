// Sentences Rust writes in English (agent checks, live-update lines, Plans and Scores notes), shown in the app's language.
// A sentence that is not one of these stays as it came. English never goes through the rules.
import { getLanguage, t } from '../i18n';
import { canaryText } from './canaryWords';

type Say = (m: RegExpExecArray) => string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- keys are checked where the rules are written
const k = (key: string, vars?: (m: RegExpExecArray) => Record<string, string | number>): Say => (m) => t(key as any, vars?.(m));
const same = (key: string): [RegExp, Say] => [new RegExp(`^${EN[key].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), k(key)];

// Fixed English sentences (the first column is the exact Rust text).
const EN: Record<string, string> = {
  'r21.w.installedPress': 'Installed. Press Test to check it can answer.',
  'r21.w.installed': 'Installed.',
  'r21.w.needsSignIn': 'It needs you to sign in first.',
  'r21.w.tooSlow': 'It is taking too long to answer.',
  'r21.w.askedPermission': 'It stopped to ask for permission instead of answering.',
  'r21.w.emptyAnswer': 'It ran but gave an empty answer.',
  'r21.w.answered': 'Ready. It answered the test question.',
  'r21.w.cannotTest': 'This agent cannot be tested automatically. Open it and say hello instead.',
  'r21.w.unknownAgent': 'Potato Workspace does not know this agent.',
  'r21.w.cantReport': "This agent can't report to Potato Workspace directly. Potato Workspace reads its screen.",
  'r21.w.liveOff': 'Live updates are off.',
  'r21.w.codexNote': 'Potato Workspace adds a small file to .codex in each project; Codex asks you to review it once per folder.',
  'r21.w.warm.dialog': 'it stops at a trust or approval prompt (open it once yourself first)',
  'r21.w.warm.untested': 'this version of it has not been tested with Potato Workspace yet',
  'r21.w.warm.attention': 'it stops at a login or update screen (finish that once yourself)',
  'r21.w.warm.dead': 'it exited right after starting',
  'r21.w.warm.exited': 'it started fine, then exited by itself',
  'r21.w.warm.timeout': 'it never reached its input box',
  'r21.w.warm.claim': 'it was not ready when a run asked for it',
  'r21.w.limitsNow': 'Counting limits from now on. Earlier limits were not recorded.',
  'r21.w.tokensPlans': 'Tokens are not counted. Only usage an agent reports itself would show here.',
  'r21.w.undoNow': 'Counting Undo from now on.',
  'r21.w.tokensScores': 'Tokens are not counted. Only usage an agent reports itself could show here, and it is not saved per turn.',
  'r23ui.w.defaultAccount': 'Default account',
  'r21.w.noTurnsProject': 'No turns have been recorded for this project yet.',
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** "24 November 2026" -> "2026年11月24日" (a day the backend wrote in English). Anything else stays. */
function day(text: string): string {
  const m = /^(\d{1,2}) (\w+) (\d{4})$/.exec(text);
  const at = m ? MONTHS.indexOf(m[2]) : -1;
  return m && at >= 0 ? `${m[3]}年${at + 1}月${+m[1]}日` : text;
}
const n = (m: RegExpExecArray, i = 1): number => +m[i];

const RULES: Array<[RegExp, Say]> = [
  ...Object.keys(EN).map(same),
  [/^Found it, but it did not start properly: (.+)$/s, k('r21.w.didNotStartProperly', (m) => ({ why: m[1] }))],
  [/^It failed: (.+)$/s, k('r21.w.failed', (m) => ({ why: m[1] }))],
  [/^Untested (.+) version\. Live updates stay watch only\.$/, k('r21.w.untestedVersion', (m) => ({ label: m[1] }))],
  [/^Connected\. (.+) tells Potato Workspace when it starts, asks and finishes\. Watch only: Potato Workspace still decides from the screen\.$/, k('r21.w.connected', (m) => ({ label: m[1] }))],
  [/^Turns on when you open (.+) in a project\. .+ then asks for your OK once per project\.$/, k('r21.w.turnsOnReview', (m) => ({ label: m[1] }))],
  [/^Turns on the next time you open (.+)\.$/, k('r21.w.turnsOnNext', (m) => ({ label: m[1] }))],
  [/^This project shares its (.+) settings in git, so Potato Workspace doesn't change them\.$/, k('r21.w.sharedInGit', (m) => ({ label: m[1] }))],
  [/^Waiting for you to trust this folder in (.+)\.$/, k('r21.w.waitTrust', (m) => ({ label: m[1] }))],
  [/^Needs your OK in (.+)\.$/, k('r21.w.needsOk', (m) => ({ label: m[1] }))],
  [/^it would not start \((.*)\)$/s, k('r21.w.warm.spawn', (m) => ({ why: m[1] }))],
  [/^Counting limits since (.+)\. Earlier limits were not recorded\.$/, k('r21.w.limitsSince', (m) => ({ day: day(m[1]) }))],
  [/^Counting limits since (.+)\.$/, k('r21.w.limitsSinceShort', (m) => ({ day: day(m[1]) }))],
  [/^(\d+) limits? ha(?:s|ve) no end time, so no waiting time is added for it\.$/, k('r21.w.noEnd', (m) => ({ count: n(m) }))],
  [/^(\d+) turns? had no file information, so (?:they|it) add(?:s)? no files\.$/, k('r21.w.noFileInfo', (m) => ({ count: n(m) }))],
  [/^(\d+) records? could not be read\. (?:Its|Their) turns are not counted\.$/, k('r21.w.unreadable', (m) => ({ count: n(m) }))],
  [/^Counting Undo since (.+)\. Earlier undos were not recorded\.$/, k('r21.w.undoSince', (m) => ({ day: day(m[1]) }))],
  [/^Counting Undo since (.+)\.$/, k('r21.w.undoSinceShort', (m) => ({ day: day(m[1]) }))],
  [/^(\d+) turns? had no summary, so (?:they are|it is) left out of Undone and Asked you\.$/, k('r21.w.noSummary', (m) => ({ count: n(m) }))],
  [/^(\d+) of (\d+) turns had checks\. Checks count only when a run is started with them\.$/, k('r21.w.checksOf', (m) => ({ with: n(m), total: n(m, 2) }))],
];

export function backendText(text: string | null | undefined): string {
  if (!text) return text ?? '';
  if (getLanguage() === 'en') return text;
  for (const [pattern, say] of RULES) {
    const hit = pattern.exec(text);
    if (hit) return say(hit);
  }
  return canaryText(text);
}
