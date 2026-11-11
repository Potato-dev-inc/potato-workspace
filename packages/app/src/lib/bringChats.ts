// "Bring my chats": the small pure helpers behind the screen. The time-range chips, the "2 days ago" words, and the lines
// that say how a run went. No agent is named here: names come from the agent list the app sends.
import type { BrowseRange, BrowseRow, ImportProgress } from './chatImport';
import { chatCount } from './chatImport';

const DAY_MS = 86_400_000;
const MAX_UNKNOWN_DATE = 0;

/** The time-range chips above the list. `days: null` is every chat; `custom` asks for two dates. */
export type RangeKey = 'days7' | 'days30' | 'months3' | 'all' | 'custom';

export const RANGE_CHIPS: { key: RangeKey; label: string; days: number | null }[] = [
  { key: 'days7', label: 'Last 7 days', days: 7 },
  { key: 'days30', label: 'Last 30 days', days: 30 },
  { key: 'months3', label: 'Last 3 months', days: 90 },
  { key: 'all', label: 'All', days: null },
  { key: 'custom', label: 'Custom…', days: null },
];

/** The range a chip means, counted back from `now`. `custom` takes the two dates ("YYYY-MM-DD", local time). */
export function rangeOf(key: RangeKey, now: number, custom?: { from: string; to: string }): BrowseRange {
  if (key === 'custom') {
    return { fromMs: custom?.from ? startOfDay(custom.from) : null, toMs: custom?.to ? endOfDay(custom.to) : null };
  }
  const chip = RANGE_CHIPS.find((c) => c.key === key);
  return { fromMs: chip?.days ? now - chip.days * DAY_MS : null, toMs: null };
}

function localDate(text: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/** 00:00 of a "YYYY-MM-DD" date in local time, or null for text that is not a date. */
export function startOfDay(text: string): number | null {
  return localDate(text)?.getTime() ?? null;
}

/** The last millisecond of a "YYYY-MM-DD" date in local time, or null for text that is not a date. */
export function endOfDay(text: string): number | null {
  const day = localDate(text);
  return day ? new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime() - 1 : null;
}

/** "just now", "5 minutes ago", "2 days ago", "3 weeks ago", "4 months ago", "2 years ago". */
export function agoText(ms: number, now: number): string {
  if (!ms || ms <= MAX_UNKNOWN_DATE) return 'Unknown date';
  const gap = Math.max(0, now - ms);
  const unit = (count: number, name: string) => `${count} ${name}${count === 1 ? '' : 's'} ago`;
  if (gap < 60_000) return 'just now';
  if (gap < 3_600_000) return unit(Math.floor(gap / 60_000), 'minute');
  if (gap < DAY_MS) return unit(Math.floor(gap / 3_600_000), 'hour');
  if (gap < 14 * DAY_MS) return unit(Math.floor(gap / DAY_MS), 'day');
  if (gap < 60 * DAY_MS) return unit(Math.floor(gap / (7 * DAY_MS)), 'week');
  if (gap < 730 * DAY_MS) return unit(Math.floor(gap / (30 * DAY_MS)), 'month');
  return unit(Math.floor(gap / (365 * DAY_MS)), 'year');
}

/** "12 messages", "1 message", "3,000+ messages" when a cap stopped the count. */
export function messageCount(row: Pick<BrowseRow, 'messages' | 'messagesCut'>): string {
  const word = row.messages === 1 && !row.messagesCut ? 'message' : 'messages';
  return `${row.messages.toLocaleString('en-US')}${row.messagesCut ? '+' : ''} ${word}`;
}

/** The line while a run works: "Bringing 37 chats… 12 done". */
export function bringingLine(progress: Pick<ImportProgress, 'chatsDone' | 'chatsTotal' | 'phase'>): string {
  if (progress.phase === 'looking' || progress.chatsTotal === 0) return 'Getting ready…';
  return `Bringing ${chatCount(progress.chatsTotal)}… ${progress.chatsDone.toLocaleString('en-US')} done`;
}

/** How many chats could not be brought in a run. */
export function failedCount(progress: Pick<ImportProgress, 'unreadable' | 'tooBig'>): number {
  return progress.unreadable + progress.tooBig;
}

/** "Done. 37 chats are now in your chat list. 2 could not be read" (the last part only when some failed). */
export function doneLine(progress: ImportProgress): string {
  const inList = progress.brought + progress.unchanged;
  const verb = inList === 1 ? 'is' : 'are';
  const parts = [inList === 0 ? 'Done. Nothing new to bring.' : `Done. ${chatCount(inList)} ${verb} now in your chat list.`];
  const failed = failedCount(progress);
  if (failed > 0) parts.push(`${failed} could not be read`);
  if (progress.empty > 0) parts.push(`${chatCount(progress.empty)} with nothing in ${progress.empty === 1 ? 'it was' : 'them were'} left out`);
  return parts.join(' ');
}

/** The "Why?" fold: one plain sentence per reason that happened. */
export function whyLines(progress: Pick<ImportProgress, 'unreadable' | 'tooBig' | 'missing' | 'format'>): string[] {
  const lines: string[] = [];
  if (progress.missing > 0) lines.push(`${chatCount(progress.missing)}: the file was moved or deleted after it was listed.`);
  if (progress.format > 0) lines.push(`${chatCount(progress.format)}: written in a format this version does not know yet.`);
  if (progress.tooBig > 0) lines.push(`${chatCount(progress.tooBig)}: too big to bring (over 64 MB).`);
  const other = progress.unreadable - progress.missing - progress.format;
  if (other > 0) lines.push(`${chatCount(other)}: the file could not be opened (it may be in use or damaged).`);
  return lines;
}
