// The live progress line (P11): one line under the header while an agent works. What it does now, the step, the minutes.
// Where the steps are not known (a chat read off the screen) it shows only the time and the last action. The drawer row shows
// the same words (`progressWords`). The line is a status region, so a screen reader hears it change without being moved.
import { useEffect, useState } from 'react';
import { useT } from '../../i18n';
import { minutesBetween, type ProgressNote } from '../../lib/phone-progress';
import '../../styles/phone-compose.css';

/** How often the minutes are worked out again. */
const TICK_MS = 15_000;

/** The words of one note, joined with a dot: "Edit src/a.ts · step 4 · 6 min". */
export function progressWords(t: ReturnType<typeof useT>, note: ProgressNote, now: number): string {
  const parts: string[] = [];
  if (note.actionKind === 'tool' && note.action) parts.push(note.action);
  else if (note.actionKind === 'thinking') parts.push(t('phone.progress.thinking'));
  else if (note.actionKind === 'writing') parts.push(t('phone.progress.writing'));
  else parts.push(t('phone.progress.working'));
  if (note.step !== null) parts.push(t('phone.progress.step', { n: note.step }));
  const minutes = minutesBetween(note.startedAt, now);
  parts.push(minutes < 1 ? t('phone.progress.underMin') : t('phone.progress.min', { n: minutes }));
  return parts.join(' · ');
}

/** The current time, moving on every 15 seconds while `on`. */
export function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, [on]);
  return now;
}

export function PhoneProgress({ note }: { note: ProgressNote | null }) {
  const t = useT();
  const now = useNow(note !== null);
  if (!note) return null;
  return (
    <p className="ph-progress" role="status" data-testid="phone-progress">
      <span className="ph-progress-dot" aria-hidden="true" />
      <span className="ph-progress-text">{progressWords(t, note, now)}</span>
    </p>
  );
}
