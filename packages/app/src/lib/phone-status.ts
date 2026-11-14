// The phone's one status line (pure). The header and the drawer rows say the same words: Sending… -> Working · 12s · step 3 of 6 ->
// Needs you / Asking you -> Done · 48s / Stopped / Ready, and Offline when the PC cannot be reached. The words come from here only,
// so they cannot drift apart. The dot says it with colour too, but never alone: every state has words.
import type { MessageKey } from '../i18n';
import type { AttentionSnapshot } from './attention';
import type { ProgressNote } from './phone-progress';

export type StatusKind = 'sending' | 'working' | 'needs' | 'asking' | 'done' | 'stopped' | 'ready' | 'offline';
/** The dot: orange = needs you, green (pulsing) = working, red = trouble, none = nothing to say. */
export type StatusDot = 'needs' | 'working' | 'danger' | 'none';

export interface StatusInput {
  /** The chat's row state from `rowState` (needs / risk / broken / working / idle). */
  state: 'needs' | 'working' | 'risk' | 'broken' | 'idle';
  /** What the live turn does now (from `useProgressNote`). */
  note?: ProgressNote | null;
  now: number;
  /** The PC cannot be reached. */
  offline?: boolean;
  /** A message was sent and the PC has not confirmed it yet. */
  sending?: boolean;
  /** The agent asked a question (a card or a choice) rather than wants an approval. */
  asking?: boolean;
  /** How long the last turn took, when it ended well (ms). Shows "Done · 48s" for a chat that is not working. */
  doneMs?: number | null;
  /** Steps in the plan, when the agent gave one. */
  total?: number | null;
}

export interface PhoneStatus {
  kind: StatusKind;
  dot: StatusDot;
  /** The line to show, already in the phone's language. */
  text: string;
}

type T = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** "12s", "2m 10s", "3m". */
export function durationWords(t: T, ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return t('phone.st.sec', { n: total });
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s === 0 ? t('phone.st.min', { m }) : t('phone.st.minSec', { m, s });
}

export function phoneStatus(t: T, input: StatusInput): PhoneStatus {
  const { state, note, now } = input;
  if (input.offline) return { kind: 'offline', dot: 'danger', text: t('phone.st.offline') };
  if (input.sending) return { kind: 'sending', dot: 'working', text: t('phone.st.sending') };
  if (state === 'broken') return { kind: 'stopped', dot: 'danger', text: t('phone.st.stopped') };
  if (state === 'needs' || state === 'risk') {
    return input.asking
      ? { kind: 'asking', dot: 'needs', text: t('phone.st.asking') }
      : { kind: 'needs', dot: 'needs', text: t('phone.st.needs') };
  }
  if (state === 'working') {
    const parts = [t('phone.st.working')];
    if (note) parts.push(durationWords(t, now - note.startedAt));
    if (note?.step != null) {
      parts.push(input.total ? t('phone.st.stepOf', { n: note.step, total: input.total }) : t('phone.st.step', { n: note.step }));
    }
    return { kind: 'working', dot: 'working', text: parts.join(' · ') };
  }
  if (input.doneMs != null && input.doneMs > 0) {
    return { kind: 'done', dot: 'none', text: `${t('phone.st.done')} · ${durationWords(t, input.doneMs)}` };
  }
  return { kind: 'ready', dot: 'none', text: t('phone.st.ready') };
}

/** True when the chat waits on a question the agent asked (not an approval): the line then says "Asking you". */
export function isAsking(attention: AttentionSnapshot | null, paneId: string): boolean {
  return (attention?.items ?? []).some((item) => item.state === 'open' && item.lane === 'blocking' && item.pane?.id === paneId && item.kind === 'question');
}
