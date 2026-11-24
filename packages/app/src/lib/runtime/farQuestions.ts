// What another PC is waiting on (its questions and approvals, `GET /pclink/questions`), as THIS PC's Inbox and counts draw them.
// Everything in an answer from another PC is untrusted text: it is cut to a size, stripped of control characters, and drawn as text.
// A far card is keyed `dev:<node>:<id>` so it can never be taken for one of this PC's own cards; the answer goes back to the far PC
// by its own id (`PcLinkClient.answerQuestion`), and the far PC settles it there.
import type { Question } from '../questions';
import { pcNameOf } from './pclink';

export const FAR_QUESTION_MAX = 30;
export const FAR_CHOICE_MAX = 12;
const TEXT_MAX = 600;
const LABEL_MAX = 80;
const ID_MAX = 120;
/** How long a card waits when the far PC does not say. */
const DEFAULT_WAIT_MS = 10 * 60_000;
const MAX_WAIT_MS = 24 * 60 * 60_000;

export interface FarQuestion {
  /** `dev:<node>:<id>`. */
  key: string;
  node: string;
  /** The far PC's name for itself in this PC's list. */
  pcName: string;
  /** The far PC's own id (what the answer route takes). */
  id: string;
  question: string;
  choices: { id: string; label: string }[];
  allowFreeText: boolean;
  /** The far chat this card belongs to (the far PC's own pane id) and what raised it (`acp_permission` for a tool permission): kept so that chat can draw its own card. */
  paneId?: string;
  kind?: string;
  /** Why Force yes left this card to the person (a short code the far PC sends, `forceYes.left.<code>`). */
  forceYesLeft?: string;
  /** How long the far PC says it waits (a number, never a date: its clock is not ours). */
  waitMs: number;
  /** When this PC first saw it (this PC's clock). Set by the reader, not by the far PC. */
  seenAt: number;
}

export const farQuestionKey = (node: string, id: string): string => `dev:${node}:${id}`;
export const isFarQuestionKey = (key: string): boolean => key.startsWith('dev:');

/** Plain short text: no control, format (bidi, zero-width) or line separator characters; cut by code points; `''` when nothing is left. */
function plain(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return Array.from(value)
    .filter((c) => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(c) || c === '\n')
    .slice(0, max)
    .join('')
    .trim();
}

/** The far PC's list as cards: at most `FAR_QUESTION_MAX`, each with a text, at most `FAR_CHOICE_MAX` choices, ids and labels cut. */
export function farQuestionsOf(node: string, pcName: string, raw: unknown, seenAt: (key: string) => number = () => Date.now()): FarQuestion[] {
  if (!Array.isArray(raw)) return [];
  const name = pcNameOf(pcName) ?? '';
  const out: FarQuestion[] = [];
  for (const entry of raw) {
    if (out.length >= FAR_QUESTION_MAX) break;
    const q = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    const id = plain(q.id, ID_MAX);
    const question = plain(q.question, TEXT_MAX);
    if (!id || !question) continue;
    const choices = (Array.isArray(q.choices) ? q.choices : [])
      .slice(0, FAR_CHOICE_MAX)
      .map((c) => ({ id: plain((c as { id?: unknown })?.id, ID_MAX), label: plain((c as { label?: unknown })?.label, LABEL_MAX) }))
      .filter((c) => c.id && c.label);
    const span = typeof q.expires_at_ms === 'number' && typeof q.created_at_ms === 'number' ? q.expires_at_ms - q.created_at_ms : NaN;
    out.push({
      key: farQuestionKey(node, id),
      node,
      pcName: name,
      id,
      question,
      choices,
      allowFreeText: q.allow_free_text === true,
      ...(plain(q.pane_id, ID_MAX) ? { paneId: plain(q.pane_id, ID_MAX) } : {}),
      ...(plain(q.kind, LABEL_MAX) ? { kind: plain(q.kind, LABEL_MAX) } : {}),
      ...(/^\w{1,40}$/.test(plain(q.force_yes_left, 40)) ? { forceYesLeft: plain(q.force_yes_left, 40) } : {}),
      waitMs: Number.isFinite(span) && span > 0 ? Math.min(span, MAX_WAIT_MS) : DEFAULT_WAIT_MS,
      seenAt: seenAt(farQuestionKey(node, id)),
    });
  }
  return out;
}

/** The card of the normal question kind that draws a far question (the same card as a question on this PC; `context` says where). */
export function asQuestion(q: FarQuestion, where: string): Question {
  return {
    id: q.key,
    question: q.question,
    choices: q.choices,
    allow_free_text: q.allowFreeText,
    context: q.forceYesLeft ? `${where}
Force yes asked: ${q.forceYesLeft}` : where,
    urgency: 'normal',
    created_at_ms: q.seenAt,
    expires_at_ms: q.seenAt + q.waitMs,
    state: 'pending',
    // Only a tool permission keeps its kind, so its card words it and badges it as a permission.
    ...(q.kind === 'acp_permission' ? { kind: q.kind } : {}),
  };
}
