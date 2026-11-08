// Words and rules for the chat's permission card ("Decision card") and for the one line it leaves in the conversation.
// Pure. Decided by the option kind and the tool kind the agent sent, never by which agent it is.
import type { AcpPermission } from './acpChat';
import type { Question } from './questions';

/** Tool kinds a person may stop being asked about in one chat (the backend refuses any other). */
const REMEMBERABLE = new Set(['read', 'edit', 'execute', 'search', 'fetch', 'think', 'switch_mode']);
/** Tool kinds whose "yes" has to be held down. */
const RISKY = new Set(['delete', 'move']);

const KIND_WORDS: Record<string, string> = {
  execute: 'Run command',
  edit: 'Edit files',
  read: 'Read files',
  delete: 'Delete files',
  move: 'Move files',
  search: 'Search',
  fetch: 'Fetch from the web',
  think: 'Think',
  switch_mode: 'Switch mode',
};

export function kindWords(kind: string | null | undefined): string | null {
  return kind ? (KIND_WORDS[kind] ?? null) : null;
}

export function isRisky(kind: string | null | undefined): boolean {
  return !!kind && RISKY.has(kind);
}

/** "Don't ask again in this chat" is offered only for kinds that are safe to remember. */
export function canRemember(kind: string | null | undefined): boolean {
  return !!kind && REMEMBERABLE.has(kind);
}

export type OptionTone = 'allow' | 'deny' | 'other';

/** What a button means, from the agent's option kind (`allow_once`, `reject_always`, ...). */
export function toneOf(optionKind: string | null | undefined): OptionTone {
  if (optionKind?.startsWith('allow')) return 'allow';
  if (optionKind?.startsWith('reject')) return 'deny';
  return 'other';
}

/** The permission of the session's state that stands for this card. */
export function permissionOf(q: Question, permissions: readonly AcpPermission[] | undefined): AcpPermission | null {
  return permissions?.find((p) => p.questionId === q.id) ?? null;
}

export interface DecisionOption {
  id: string;
  label: string;
  tone: OptionTone;
}

/** The card's buttons in the agent's order. The kind comes from the session when it knows it, else from the id. */
export function decisionOptions(q: Question, permission: AcpPermission | null): DecisionOption[] {
  return q.choices.map((c) => {
    const kind = permission?.options?.find((o) => o.id === c.id)?.kind ?? c.id;
    return { id: c.id, label: c.label, tone: toneOf(kind) };
  });
}

/** What the agent wants to do: the tool's title from the session, else the part of the question after the colon. */
export function whatIsAsked(q: Question, permission: AcpPermission | null): string {
  const title = permission?.title?.trim();
  if (title) return title;
  const at = q.question.indexOf(': ');
  return at >= 0 ? q.question.slice(at + 2).trim() : '';
}

/** Whether a title needs the "Show full" toggle. */
export function isLong(text: string): boolean {
  return text.length > 90 || text.includes('\n');
}

export interface Verdict {
  /** `allow`, `deny`, `wait` or `note` (the agent's own option word, or a cancel). */
  tone: 'allow' | 'deny' | 'wait' | 'note';
  head: string;
  title: string;
  /** Allowed by the person's "don't ask again". */
  auto: boolean;
}

const AUTO_HEAD = 'Allowed automatically';

/** Reads the chat's `permission` notice (`Allowed · title`, `Denied · title`, `Waiting for your answer: title`, ...). */
export function parseVerdict(text: string): Verdict {
  const wait = /^Waiting for your answer:\s*(.*)$/s.exec(text);
  if (wait) return { tone: 'wait', head: 'Waiting for you', title: wait[1] ?? '', auto: false };
  const at = text.indexOf(' · ');
  const head = at >= 0 ? text.slice(0, at) : text;
  const title = at >= 0 ? text.slice(at + 3) : '';
  if (head === 'Allowed') return { tone: 'allow', head, title, auto: false };
  if (head.startsWith(AUTO_HEAD)) return { tone: 'allow', head: AUTO_HEAD, title, auto: true };
  if (head === 'Denied') return { tone: 'deny', head, title, auto: false };
  return { tone: 'note', head: text, title: '', auto: false };
}
