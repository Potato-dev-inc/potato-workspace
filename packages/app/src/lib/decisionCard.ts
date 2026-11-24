// Words and rules for the chat's permission card ("Decision card") and for the one line it leaves in the conversation.
// Pure. Decided by the option kind and the tool kind the agent sent, never by which agent it is.
import type { AcpPermission } from './acpChat';
import { getLanguage, t } from '../i18n';
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
  if (!kind || !KIND_WORDS[kind]) return null;
  return getLanguage() === 'en' ? KIND_WORDS[kind] : t(`decision.kind.${kind}` as never);
}

const OPTION_WORDS: Record<string, string> = { allow_once: 'risk.choice.allowOnce', allow_always: 'risk.choice.allowSession', reject_once: 'risk.choice.deny' };

/** The button's words: in another language than English the standard option kinds get the app's own translated labels (the agent's names are English); a label that says more than the kind (a command in backticks) stays as the agent wrote it. English keeps the agent's own names. */
export function optionWords(kind: string | null | undefined, name: string): string {
  if (getLanguage() === 'en' || name.includes('`')) return name;
  // A far chat sends the agent's option id (`allow`, `allow_session`, `proceed_once`), not its kind: read id and label together, "always" wins over "once".
  const exact = kind ? OPTION_WORDS[kind] : undefined;
  if (exact) return t(exact as never);
  const kinds = [wordKind(kind), wordKind(name)];
  const hit = ['allow_always', 'reject_once', 'allow_once'].find((k) => kinds.includes(k));
  return hit ? t(OPTION_WORDS[hit] as never) : name;
}

/** The standard kind a loose id or English label stands for, or null. */
function wordKind(w: string | null | undefined): string | null {
  const s = (w ?? '').trim().toLowerCase().replace(/[_-]+/g, ' ');
  if (/^(no|deny|reject|cancel|decline)(?![a-z])|^reject/.test(s) || /^no[,.!]/.test(s)) return 'reject_once';
  if (/always|all edits|session|allow all|remember|don't ask/.test(s)) return 'allow_always';
  if (/^(yes|allow|approve|proceed|ok|accept)(?![a-z])/.test(s)) return 'allow_once';
  return null;
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
    return { id: c.id, label: optionWords(kind, c.label), tone: toneOf(kind) };
  });
}

/** What the agent wants to do: the tool's title from the session, else the part of the question after the colon. */
export function whatIsAsked(q: Question, permission: AcpPermission | null): string {
  const title = permission?.title?.trim();
  if (title) return title;
  const at = q.question.indexOf(': ');
  return at >= 0 ? q.question.slice(at + 2).trim() : '';
}

/** Why Force yes left this question to the person: the code the app put in the card's context (`Force yes asked: <code>`), else null. */
export function forceYesLeft(q: Question): string | null {
  const m = /^Force yes asked: (\w+)$/m.exec(q.context ?? '');
  return m?.[1] ?? null;
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
