// The words of the phone approval card and its queue, in one place (design 2.9). Sentence case, plain
// words, no raw ids. The risk words are the desktop card's (`LEVEL_WORD` in approval-risk.ts).
// Every word is read when it is used (getters and functions), so a language switch shows at the next render.
import { t } from '../i18n';
import type { AttentionItem } from './attention';

/** "Claude", or "The agent" for an item with no pane. */
export function agentName(item: Pick<AttentionItem, 'pane'>): string {
  return item.pane?.agent?.trim() || t('inboxCards.attention.theAgent');
}

/** 24-hour clock time, the way the lock screen and the PC print it: "09:41". */
export function formatClock(ms: number): string {
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** "2 min", "1 h 4 min", "just now". */
export function formatAge(fromMs: number, nowMs: number): string {
  const minutes = Math.max(0, Math.floor((nowMs - fromMs) / 60_000));
  if (minutes < 1) return t('inboxCards.age.justNow');
  if (minutes < 60) return t('inboxCards.age.minutes', { n: minutes });
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? t('inboxCards.age.hours', { n: h }) : t('inboxCards.age.hoursMinutes', { h, m });
}

/** "in 8 min", "in 45 s": how long a question still waits. */
export function formatWait(msLeft: number): string {
  const left = Math.max(0, msLeft);
  if (left < 60_000) return t('inboxCards.age.seconds', { n: Math.max(1, Math.round(left / 1000)) });
  return t('inboxCards.age.minutes', { n: Math.max(1, Math.round(left / 60_000)) });
}

export const COPY = {
  /** A new prompt is up (or none is): the old card says so and never answers the new one. */
  get changed() {
    return t('inboxCards.attention.changed');
  },
  gone: (agent: string) => t('inboxCards.attention.gone', { agent }),
  alreadyPc: (label: string) => t('inboxCards.attention.alreadyPc', { label }),
  alreadyYou: (label: string) => t('inboxCards.attention.alreadyYou', { label }),
  alreadyPhone: (device: string, label: string) => t('inboxCards.attention.alreadyPhone', { device, label }),
  /** "Allowed once · 09:41 · from this phone" */
  answered: (label: string, clock: string) => t('inboxCards.attention.answered', { label, clock }),
  failed: (agent: string) => t('inboxCards.attention.failed', { agent }),
  get offline() {
    return t('inboxCards.attention.offline');
  },
  get lost() {
    return t('inboxCards.attention.lost');
  },
  get sending() {
    return t('inboxCards.attention.sending');
  },
  get sendingToPc() {
    return t('inboxCards.attention.sendingToPc');
  },
  get stillSending() {
    return t('inboxCards.attention.stillSending');
  },
  get watchOnly() {
    return t('inboxCards.attention.watchOnly');
  },
  get controlOnly() {
    return t('inboxCards.attention.controlOnly');
  },
  get provenanceScreen() {
    return t('inboxCards.attention.provenanceScreen');
  },
  get caution() {
    return t('inboxCards.attention.caution');
  },
  noPrompt: (agent: string) => ({
    title: t('inboxCards.attention.noPromptTitle', { agent }),
    body: t('inboxCards.attention.noPromptBody'),
  }),
  signIn: (agent: string) => ({
    title: t('inboxCards.attention.signInTitle', { agent }),
    body: t('inboxCards.attention.signInBody'),
  }),
  expired: (agent: string, clock: string) => t('inboxCards.attention.expired', { agent, clock }),
  /** "1 more waiting" / "3 more waiting" */
  queue: (n: number) => t('inboxCards.attention.queue', { count: n }),
  get empty() {
    return { title: t('inboxCards.attention.emptyTitle'), body: t('inboxCards.attention.emptyBody') };
  },
  get dealtWith() {
    return t('inboxCards.attention.dealtWith');
  },
  get showDetails() {
    return t('inboxCards.showDetails');
  },
  get hideDetails() {
    return t('inboxCards.hideDetails');
  },
  get openPane() {
    return t('inboxCards.attention.openPane');
  },
  get tryAgain() {
    return t('inboxCards.attention.tryAgain');
  },
  /** After "This question changed": show the card again with the PC's current list. */
  get lookAgain() {
    return t('inboxCards.attention.lookAgain');
  },
} as const;

/** How long a fresh "Sending" stays plain, then turns to "Sending to your PC", then "Still sending". */
export const SENDING_PHASE_MS = { toPc: 1_500, still: 8_000, lost: 20_000 } as const;

export type SendingPhase = 'sending' | 'sending_pc' | 'still' | 'lost';

/** What the card says about an answer that was sent `elapsedMs` ago and has not come back. */
export function sendingPhase(elapsedMs: number): SendingPhase {
  if (elapsedMs >= SENDING_PHASE_MS.lost) return 'lost';
  if (elapsedMs >= SENDING_PHASE_MS.still) return 'still';
  if (elapsedMs >= SENDING_PHASE_MS.toPc) return 'sending_pc';
  return 'sending';
}

export function sendingText(phase: Exclude<SendingPhase, 'lost'>): string {
  return phase === 'sending' ? COPY.sending : phase === 'sending_pc' ? COPY.sendingToPc : COPY.stillSending;
}
