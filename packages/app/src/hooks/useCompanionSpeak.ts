// Feeds the speak rules (lib/companionSpeak) with what the app already knows: agents waiting a long time (the Inbox
// items), a run that finished, a usage warning. Shows at most one bubble at a time. Nothing here asks the backend.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { NeedsYouItem } from '../lib/attention';
import type { CompanionView } from '../lib/companion';
import {
  MEMORY_CHANGED_EVENT,
  WAIT_SPEAK_MS,
  afterLater,
  afterShown,
  afterTooMuch,
  loadMemory,
  minutesSince,
  pickSpeak,
  saveMemory,
  usageThreshold,
  type SpeakEvent,
  type SpeakMemory,
  type SpeakSettings,
} from '../lib/companionSpeak';
import { isAsleepHour } from '../lib/companionMood';
import { inQuietHours } from '../lib/notify-levels';
import { readQuiet } from '../lib/notify-store';
import { headline, warns, type UsageRow } from '../lib/usage';

/** How often the rules look again. */
export const SPEAK_TICK_MS = 15_000;
/** A finished run is worth a word for this long. */
const FINISHED_FRESH_MS = 5 * 60_000;
const WAITING_KINDS: ReadonlySet<string> = new Set(['approval', 'question', 'consent', 'gate']);

export interface SpeakPane {
  id: string;
  status: string;
}

export interface CompanionSpeakInput {
  settings: SpeakSettings;
  companion: CompanionView | null;
  needsYou: readonly NeedsYouItem[];
  panes: readonly SpeakPane[];
  nameOf: (paneId: string) => string;
  usageRows?: readonly UsageRow[];
  /** Tests: the clock. */
  now?: () => number;
}

/** The candidates from the facts. Pure. */
export function speakCandidates(
  input: Pick<CompanionSpeakInput, 'needsYou' | 'nameOf' | 'usageRows'> & { finished: ReadonlyArray<{ paneId: string; at: number }> },
  now: number,
): SpeakEvent[] {
  const out: SpeakEvent[] = [];
  for (const item of input.needsYou) {
    if (!item.paneId || !item.since || !WAITING_KINDS.has(item.kind)) continue;
    if (now - item.since < WAIT_SPEAK_MS) continue;
    out.push({ key: `waiting:${item.id}`, kind: 'waiting', paneId: item.paneId, name: input.nameOf(item.paneId), minutes: minutesSince(item.since, now), yesNo: item.kind === 'approval' || item.kind === 'consent' });
  }
  for (const f of input.finished) {
    if (now - f.at > FINISHED_FRESH_MS) continue;
    out.push({ key: `finished:${f.paneId}:${f.at}`, kind: 'finished', paneId: f.paneId, name: input.nameOf(f.paneId) });
  }
  for (const row of input.usageRows ?? []) {
    if (!warns(row)) continue;
    const percent = row.state === 'ok' ? Math.round(headline(row)?.used_percent ?? 100) : 100;
    const threshold = usageThreshold(percent);
    if (threshold === null) continue;
    // One bubble per threshold per reset window: the window is the row's reset time, or today's date when it has none.
    const windowId = headline(row)?.resets_at_ms ?? new Date(now).toDateString();
    out.push({ key: `usage:${row.agent_id}:${row.account_id ?? ''}:${threshold}:${windowId}`, kind: 'usage', name: row.label, percent, threshold });
  }
  return out;
}

/** True while the focus is in a text field (the person is typing there). */
const inField = (target: EventTarget | null): boolean => {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable === true);
};

export interface CompanionSpeak {
  event: SpeakEvent | null;
  /** "Open": the bubble is answered. */
  open: () => void;
  later: () => void;
  tooMuch: () => void;
}

export function useCompanionSpeak(input: CompanionSpeakInput): CompanionSpeak {
  const [event, setEvent] = useState<SpeakEvent | null>(null);
  const shownRef = useRef<SpeakEvent | null>(null);
  const show = useCallback((next: SpeakEvent | null) => {
    shownRef.current = next;
    setEvent(next);
  }, []);
  const memory = useRef<SpeakMemory | null>(null);
  const lastTyped = useRef<number | null>(null);
  const prevStatus = useRef<Map<string, string>>(new Map());
  const finished = useRef<Array<{ paneId: string; at: number }>>([]);
  const latest = useRef(input);
  latest.current = input;
  const clock = input.now ?? Date.now;
  /** The memory, read from storage the first time (so a reload does not forget what was said). */
  const mem = (): SpeakMemory => (memory.current ??= loadMemory(clock()));

  // Settings turned a kind back on: read the saved memory again (the budget of bubbles shown is kept).
  useEffect(() => {
    const onChanged = () => {
      const saved = loadMemory(clock());
      memory.current = { ...saved, shownAt: memory.current?.shownAt ?? [] };
    };
    window.addEventListener(MEMORY_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(MEMORY_CHANGED_EVENT, onChanged);
  }, [clock]);

  // The person types: stay quiet for a few seconds.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (inField(e.target)) lastTyped.current = Date.now();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // A run that went from working to calm is "finished".
  useEffect(() => {
    const now = clock();
    for (const p of input.panes) {
      if (prevStatus.current.get(p.id) === 'running' && p.status === 'idle') finished.current.push({ paneId: p.id, at: now });
      prevStatus.current.set(p.id, p.status);
    }
    finished.current = finished.current.filter((f) => now - f.at <= FINISHED_FRESH_MS);
  }, [input.panes, clock]);

  const tick = useCallback(() => {
    const cur = latest.current;
    const now = clock();
    const date = new Date(now);
    const minuteOfDay = date.getHours() * 60 + date.getMinutes();
    const companion = cur.companion;
    if (!companion) return;
    const asleep = companion.state === 'sleeping' || companion.state === 'stopped' || companion.state === 'starting' || isAsleepHour(date.getHours());
    const candidates = speakCandidates({ needsYou: cur.needsYou, nameOf: cur.nameOf, usageRows: cur.usageRows, finished: finished.current }, now);
    const shown = shownRef.current;
    if (shown) {
      // The thing a bubble talks about went away (the agent was answered): the bubble goes too.
      if (shown.kind === 'waiting' && !candidates.some((c) => c.key === shown.key)) show(null);
      return;
    }
    const pick = pickSpeak(cur.settings, mem(), { now, lastTypedAt: lastTyped.current, inQuietHours: inQuietHours(minuteOfDay, readQuiet()), asleep }, candidates);
    if (!pick) return;
    memory.current = afterShown(mem(), pick, now);
    saveMemory(memory.current);
    show(pick);
  }, [clock, show]);

  useEffect(() => {
    if (!input.settings.on) {
      show(null);
      return undefined;
    }
    tick();
    const id = setInterval(tick, SPEAK_TICK_MS);
    return () => clearInterval(id);
  }, [input.settings.on, input.needsYou, input.usageRows, input.companion?.state, tick, show]);

  const done = useCallback(() => show(null), [show]);
  const later = useCallback(() => {
    if (shownRef.current) {
      memory.current = afterLater(mem(), shownRef.current, clock());
      saveMemory(memory.current);
    }
    show(null);
  }, [clock, show]);
  const tooMuch = useCallback(() => {
    if (shownRef.current) {
      memory.current = afterTooMuch(mem(), shownRef.current.kind);
      saveMemory(memory.current);
    }
    show(null);
  }, [clock, show]);

  return { event, open: done, later, tooMuch };
}
