// "Marked up: <page> · 2 marks": a message the app itself sent after the person marked up a page in the agent browser is
// shown as one card (the page details and the numbered marks) plus the person's own words as a normal bubble. The agent
// gets the full text unchanged. Same anti-spoof rule as the workflow card (lib/workflowCard.ts): the send path records,
// per chat on this PC, the exact message it sent; the view folds a message only when it equals a recorded one. A person
// who types the same words sees plain text, and old chats (no record) are unchanged.

export const LS_MARKUP_SENDS = 'pm.markupSends';
const MAX_PER_CHAT = 30;
const MAX_CHATS = 100;

export interface MarkupSend {
  /** The whole message as the agent received it (the picture line included). */
  text: string;
  /** The first part of `text`: the sentence that carries the person's words. */
  head: string;
  /** The person's own words; empty when only text notes were written. */
  comment: string;
  /** The page's title, or its host. Page-derived: shown as plain text only. */
  page: string;
  marks: number;
}

export interface MarkupSplit {
  page: string;
  marks: number;
  /** What the card shows when open: the message without the head (page, numbered marks, the data note). */
  details: string;
  /** The person's own words (may be empty). */
  comment: string;
}

const listeners = new Set<() => void>();
/** Called after a record is stored, so an open chat redraws and the card can appear. */
export function onMarkupSendsChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

const clean = (v: unknown): MarkupSend | null => {
  const s = v as Partial<MarkupSend> | null;
  if (!s || typeof s.text !== 'string' || typeof s.head !== 'string' || typeof s.comment !== 'string' || typeof s.page !== 'string') return null;
  if (s.text.trim() === '' || !s.text.startsWith(s.head)) return null;
  return { text: s.text, head: s.head, comment: s.comment, page: s.page, marks: typeof s.marks === 'number' && s.marks > 0 ? Math.floor(s.marks) : 1 };
};

function readAll(): Record<string, MarkupSend[]> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(LS_MARKUP_SENDS) ?? 'null');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, MarkupSend[]> = {};
    for (const [pane, list] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      const ok = list.map(clean).filter((x): x is MarkupSend => x !== null);
      if (ok.length > 0) out[pane] = ok;
    }
    return out;
  } catch {
    return {};
  }
}

/** Remembers one message the app sent to this chat. The newest 30 per chat and 100 chats are kept. Never throws. */
export function recordMarkupSend(paneId: string, send: MarkupSend): void {
  try {
    const entry = clean(send);
    if (!entry || !paneId) return;
    const all = readAll();
    const mine = [...(all[paneId] ?? []).filter((x) => x.text !== entry.text), entry].slice(-MAX_PER_CHAT);
    delete all[paneId];
    all[paneId] = mine;
    const keys = Object.keys(all);
    for (const old of keys.slice(0, Math.max(0, keys.length - MAX_CHATS))) delete all[old];
    localStorage.setItem(LS_MARKUP_SENDS, JSON.stringify(all));
  } catch {
    /* storage can be blocked: the chat then shows the plain text */
  }
  listeners.forEach((fn) => fn());
}

export function readMarkupSends(paneId: string | null | undefined): MarkupSend[] {
  return paneId ? (readAll()[paneId] ?? []) : [];
}

/** Folds a user message into a card; null (show it as it is) unless it equals a recorded message exactly. */
export function splitMarkupMessage(text: string, sends: readonly MarkupSend[]): MarkupSplit | null {
  const hit = sends.find((s) => s.text === text);
  if (!hit) return null;
  return { page: hit.page, marks: hit.marks, details: text.slice(hit.head.length).trim(), comment: hit.comment };
}

/** The event the app sends before it sends the message (see `markup://sent` in markup/live.rs). */
export function recordFromEvent(payload: unknown): void {
  const p = payload as { paneId?: unknown; text?: unknown; head?: unknown; comment?: unknown; page?: unknown; marks?: unknown } | null;
  if (!p || typeof p.paneId !== 'string' || typeof p.text !== 'string' || typeof p.head !== 'string') return;
  recordMarkupSend(p.paneId, { text: p.text, head: p.head, comment: typeof p.comment === 'string' ? p.comment : '', page: typeof p.page === 'string' ? p.page : '', marks: typeof p.marks === 'number' ? p.marks : 1 });
}
