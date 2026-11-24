// Small text helpers of the chat views: durations, counts and file names. Pure code.
import { getLanguage, t, type MessageKey } from '../../i18n';
import { CODEX_UNSET } from '../../lib/sessionChatModel';
import { lessThan, unit } from '../../lib/unitWords';

/** "800ms" is "<1s"; "12s"; "2m 5s". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return lessThan('s');
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return unit('s', seconds);
  return `${unit('m', Math.floor(seconds / 60))} ${unit('s', seconds % 60)}`;
}

/** "1 file", "3 files". */
export function plural(count: number, word: string): string {
  return `${count} ${count === 1 ? word : `${word}s`}`;
}

/** The last part of a path, for either slash ("a/b.ts", "a\\b.ts"). */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part !== '');
  return parts[parts.length - 1] ?? path;
}

/** The backend's English turn ending ("Done · 3 files · 2 min", "You stopped it") in the app's language; any other text stays as it came. */
export function endingText(text: string): string {
  if (getLanguage() === 'en') return text;
  if (text === 'You stopped it') return t('chat.end.stopped');
  const whole: Record<string, MessageKey> = {
    [CODEX_UNSET]: 'r13.end.codexUnset',
    'Probably signed out': 'r9.end.signedOut',
    'The turn ended with no answer': 'r9.end.empty',
    'It stopped at its step limit': 'r9.end.steps',
    'It stopped at its length limit': 'r9.end.length',
    'The agent declined to continue': 'r9.end.declined',
    'The app closed while this was running.': 'r9.end.closed',
  };
  if (whole[text]) return t(whole[text]);
  let hit: RegExpExecArray | null;
  if ((hit = /^No answer for (\d+) min$/.exec(text))) return t('r9.end.noAnswer', { n: hit[1] });
  if ((hit = /^(.+) hit its usage limit$/.exec(text))) return t('r9.end.usage', { agent: hit[1] });
  const parts = text.split(' · ');
  if (parts[0] !== 'Done') return text;
  const word = (p: string): string | null => {
    let m: RegExpExecArray | null;
    if (p === 'Done') return t('chat.end.done');
    if (p === '1 file') return t('chat.end.file');
    if ((m = /^(\d+) files$/.exec(p))) return t('chat.end.files', { n: m[1] });
    if ((m = /^(\d+) s$/.exec(p))) return t('chat.end.sec', { n: m[1] });
    if ((m = /^(?:(\d+) h )?(\d+) min$/.exec(p))) return (m[1] ? t('chat.end.hour', { n: m[1] }) + ' ' : '') + t('chat.end.min', { n: m[2] });
    if ((m = /^(\d+) h$/.exec(p))) return t('chat.end.hour', { n: m[1] });
    return null;
  };
  const out = parts.map(word);
  return out.every((w) => w !== null) ? out.join(' · ') : text;
}
