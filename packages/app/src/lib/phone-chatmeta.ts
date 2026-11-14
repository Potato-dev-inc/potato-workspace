// What the phone knows about each chat that the header and the drawer need but only the open chat can work out: is a message
// still on its way to the PC, how long the last turn took, how many steps the plan has, and a short label from the first message
// (the title when the PC gave none). The open chat publishes; the header and drawer read. Same store shape as phone-progress.ts.
import { useSyncExternalStore } from 'react';

export interface ChatMeta {
  /** A message was sent and the PC has not confirmed it yet. */
  sending: boolean;
  /** How long the last finished turn took (ms), or null. */
  doneMs: number | null;
  /** Steps in the agent's plan, or null when it gave none. */
  total: number | null;
  /** A short label from the chat's first message, or null. */
  label: string | null;
}

export const EMPTY_META: ChatMeta = { sending: false, doneMs: null, total: null, label: null };
export const LABEL_MAX = 32;

/** "Fix the pairing check in the bridge so it stops…": the first line, cut at a word, at most LABEL_MAX characters. */
export function labelFromMessage(text: string | null | undefined): string | null {
  const flat = (text ?? '').replace(/`+/g, '').replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  if (flat.length <= LABEL_MAX) return flat;
  const cut = flat.slice(0, LABEL_MAX - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > 12 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

const metas = new Map<string, ChatMeta>();
const listeners = new Set<() => void>();
let version = 0;
let labelsSnapshot: ReadonlyMap<string, string> = new Map();

function same(a: ChatMeta, b: ChatMeta): boolean {
  return a.sending === b.sending && a.doneMs === b.doneMs && a.total === b.total && a.label === b.label;
}

/** Merges the given fields into one chat's meta. A label is kept once known (the first message does not change). */
export function publishChatMeta(paneId: string, patch: Partial<ChatMeta>): void {
  const had = metas.get(paneId) ?? EMPTY_META;
  const next: ChatMeta = { ...had, ...patch };
  if (patch.label === null && had.label) next.label = had.label;
  if (same(had, next)) return;
  metas.set(paneId, next);
  version += 1;
  labelsSnapshot = new Map([...metas].flatMap(([id, m]) => (m.label ? [[id, m.label] as [string, string]] : [])));
  for (const listener of [...listeners]) listener();
}

export function chatMetaOf(paneId: string): ChatMeta {
  return metas.get(paneId) ?? EMPTY_META;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useChatMeta(paneId: string): ChatMeta {
  useSyncExternalStore(subscribe, () => version, () => version);
  return chatMetaOf(paneId);
}

/** The first-message labels of every chat read so far (a new object whenever one changes). */
export function useChatLabels(): ReadonlyMap<string, string> {
  return useSyncExternalStore(subscribe, () => labelsSnapshot, () => labelsSnapshot);
}

export function resetChatMetaForTests(): void {
  metas.clear();
  labelsSnapshot = new Map();
  version += 1;
}
