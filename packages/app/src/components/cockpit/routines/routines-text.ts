// Plain words for the Routines page: pure helpers that turn the engine's data into sentences. Words come from the
// translation keys (`routines.*`); nothing here is English.
import type { MessageKey } from '../../../i18n';
import type { RunView, StepView, WorkflowView } from '../../../lib/routines';

export type T = (key: MessageKey, vars?: Record<string, string | number>) => string;

const WEEKDAYS = [1, 2, 3, 4, 5];

const sameDays = (a: number[], b: number[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

/** "Weekdays at 09:00", "Mon, Wed at 18:30", "Every day at 07:00"; chains and manual ones say what starts them. */
export function whenText(w: Pick<WorkflowView, 'kind' | 'days' | 'time' | 'onlyIfOk'>, t: T): string {
  if (w.kind === 'manual') return t('routines.when.manual');
  if (w.kind === 'chain') return t(w.onlyIfOk ? 'routines.when.chainOk' : 'routines.when.chain');
  const time = w.time ?? '';
  if (w.days.length === 0 || w.days.length === 7) return t('routines.when.everyDay', { time });
  if (sameDays(w.days, WEEKDAYS)) return t('routines.when.weekdays', { time });
  const days = [...w.days].sort().map((d) => t(`routines.day.${d}` as MessageKey)).join(', ');
  return t('routines.when.days', { days, time });
}

/** A moment as "Mon 09:00" (this week) or a short date with the time. */
export function formatWhen(ms: number, lang: string, now: number = Date.now()): string {
  const date = new Date(ms);
  const near = Math.abs(ms - now) < 6 * 24 * 3_600_000;
  const options: Intl.DateTimeFormatOptions = near
    ? { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }
    : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false };
  try {
    return new Intl.DateTimeFormat(lang, options).format(date);
  } catch {
    return date.toISOString().slice(0, 16).replace('T', ' ');
  }
}

/** The time of day as "09:00". */
export function clock(ms: number, lang: string): string {
  try {
    return new Intl.DateTimeFormat(lang, { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(11, 16);
  }
}

const short = (text: string, max = 60) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The folder's last name only, so a long path does not fill the row. */
export function folderName(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export function stepText(step: StepView, t: T, agentLabel: (id: string) => string): string {
  switch (step.kind) {
    case 'start_agent':
      return t('routines.step.start_agent', { agent: agentLabel(step.agent ?? ''), project: folderName(step.project ?? '') });
    case 'wait':
      return t('routines.step.wait');
    case 'follow_up':
      return t('routines.step.follow_up', { text: short(step.text ?? '') });
    case 'notify':
      return t('routines.step.notify', { text: short(step.text ?? '') });
  }
}

/** Why a run ended, or what it waits for. Empty when there is nothing to say. */
export function noteText(run: Pick<RunView, 'noteCode' | 'noteDetail' | 'dueMs'>, t: T, lang: string): string {
  const code = run.noteCode;
  if (!code) return '';
  if (code === 'late') return t('routines.note.late', { time: run.dueMs ? clock(run.dueMs, lang) : '' });
  const known = [
    'app_closed',
    'timeout',
    'asked',
    'stopped',
    'chat_gone',
    'unfinished',
    'not_ok',
    'refused',
    'failed',
  ];
  if (!known.includes(code)) return '';
  const base = t(`routines.note.${code}` as MessageKey);
  return run.noteDetail ? `${base} ${run.noteDetail}` : base;
}
