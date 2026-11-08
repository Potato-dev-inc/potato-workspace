// The message box keeps what you typed: one unsent draft per pane, kept in localStorage so it survives switching
// panes, split view and closing the phone tab. Drafts are dropped after 7 days, at most 50 are kept, and a text over
// 20000 characters is not kept. Every storage call is wrapped: a storage that throws (private mode, blocked site
// data) just means no draft, and the box still works.
// `useComposerDraft` is the other kind of draft: a message the Point and Fix box put into a pane's Chat box ("Edit in
// Chat"). The backend holds it until the Chat tab takes it, so it is never lost while the tab is closed.

import { useEffect, useRef, useState } from 'react';
import { pointApi } from './point-api';
import type { ChatAttachment } from './attachFiles';

export const LS_COMPOSER_DRAFTS = 'pm.composerDrafts';
/** How long after the last change the draft is written (the box is also written when it goes away). */
export const DRAFT_SAVE_MS = 300;
/** A draft not written for this long is dropped. */
export const DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** At most this many drafts are kept; the oldest go first. */
export const DRAFT_MAX_COUNT = 50;
/** A longer text is not kept as a draft. */
export const DRAFT_MAX_CHARS = 20000;

interface DraftEntry {
  text: string;
  /** When the draft was last written (ms since 1970). */
  at: number;
  /** Files attached but not sent yet. Absent in drafts written before attachments existed. */
  attachments?: ChatAttachment[];
}
type DraftMap = Record<string, DraftEntry>;

function isEntry(value: unknown): value is DraftEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<DraftEntry>;
  return typeof entry.text === 'string' && typeof entry.at === 'number' && Number.isFinite(entry.at);
}

/** A stored attachment that has the fields a chip needs; anything else is dropped from the draft. */
function isAttachment(value: unknown): value is ChatAttachment {
  if (!value || typeof value !== 'object') return false;
  const a = value as Partial<ChatAttachment>;
  return typeof a.name === 'string' && typeof a.path === 'string' && typeof a.size === 'number' && (a.kind === 'text' || a.kind === 'image' || a.kind === 'file' || a.kind === 'folder');
}

/** The attachments a draft entry holds, checked; [] when there are none or the stored value is not a list. */
function attachmentsOf(entry: DraftEntry): ChatAttachment[] {
  return Array.isArray(entry.attachments) ? entry.attachments.filter(isAttachment) : [];
}

/** The drafts still fresh, newest first, at most DRAFT_MAX_COUNT. Pure: `now` is passed in. */
export function keepFresh(map: DraftMap, now: number): DraftMap {
  const fresh = Object.entries(map)
    .filter(([, entry]) => now - entry.at <= DRAFT_MAX_AGE_MS)
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, DRAFT_MAX_COUNT);
  return Object.fromEntries(fresh);
}

/** Every fresh draft. A stored value that is not readable counts as no drafts (so a write can start over). */
function readAll(now: number): DraftMap {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(localStorage.getItem(LS_COMPOSER_DRAFTS) ?? 'null');
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const map: DraftMap = {};
  for (const [paneId, entry] of Object.entries(parsed)) if (isEntry(entry)) map[paneId] = entry;
  return keepFresh(map, now);
}

/** The unsent text for this pane, or '' when there is none (or storage cannot be read). */
export function readDraft(paneId: string, now = Date.now()): string {
  try {
    return readAll(now)[paneId]?.text ?? '';
  } catch {
    return '';
  }
}

/** The unsent text and attached files for this pane (both empty when there is no draft). */
export function readDraftState(paneId: string, now = Date.now()): { text: string; attachments: ChatAttachment[] } {
  try {
    const entry = readAll(now)[paneId];
    return entry ? { text: entry.text, attachments: attachmentsOf(entry) } : { text: '', attachments: [] };
  } catch {
    return { text: '', attachments: [] };
  }
}

/**
 * Keeps the text and attached files for this pane. A blank text with no files, or a text too long to keep, removes
 * the pane's draft.
 */
export function writeDraft(paneId: string, text: string, now = Date.now(), attachments: readonly ChatAttachment[] = []): void {
  try {
    const map = readAll(now);
    const empty = text.trim() === '' && attachments.length === 0;
    if (empty || Array.from(text).length > DRAFT_MAX_CHARS) delete map[paneId];
    else map[paneId] = attachments.length > 0 ? { text, at: now, attachments: [...attachments] } : { text, at: now };
    localStorage.setItem(LS_COMPOSER_DRAFTS, JSON.stringify(keepFresh(map, now)));
  } catch {
    /* private mode, full or blocked storage: no draft */
  }
}

/** Forgets the draft for this pane (a message was sent). Other panes' drafts are left exactly as they are. */
export function clearDraft(paneId: string): void {
  try {
    const raw = localStorage.getItem(LS_COMPOSER_DRAFTS);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    const map = { ...(parsed as DraftMap) };
    delete map[paneId];
    localStorage.setItem(LS_COMPOSER_DRAFTS, JSON.stringify(map));
  } catch {
    /* private mode, full or blocked storage: no draft to clear */
  }
}

/** A Point and Fix message for this pane's Chat box. `nonce` tells two drafts with the same text apart. */
export interface ComposerDraft {
  /** The pane the draft is for: a draft is never shown in another pane's box. */
  paneId: string;
  text: string;
  nonce: number;
}

let draftNonce = 0;

const isTauri = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** Takes the pending Point draft for a pane (the backend gives it once). A failed call means no draft. */
async function takePointDraft(paneId: string): Promise<string | null> {
  try {
    const text = await pointApi.takeDraft(paneId);
    return typeof text === 'string' && text.trim() !== '' ? text : null;
  } catch {
    return null;
  }
}

/** A draft that arrives after the pane's box is gone is kept as the pane's saved draft, so nothing is lost. */
function keepForLater(paneId: string, text: string): void {
  const kept = readDraft(paneId);
  writeDraft(paneId, kept ? `${kept}\n\n${text}` : text);
}

/**
 * The Point and Fix draft waiting for this pane's Chat box, or null. It is taken when the pane's Chat box mounts and
 * again whenever `point://draft` names the pane. `null` (no pane, or the box is not shown) does nothing.
 */
export function useComposerDraft(paneId: string | null): ComposerDraft | null {
  const [draft, setDraft] = useState<ComposerDraft | null>(null);
  /** The pane whose box is mounted now (null after unmount): a late result for another pane is kept for later. */
  const shown = useRef<string | null>(null);

  useEffect(() => {
    shown.current = paneId;
    setDraft(null);
    if (!paneId || !isTauri()) return;
    const take = () => {
      void takePointDraft(paneId).then((text) => {
        if (text === null) return;
        if (shown.current === paneId) setDraft({ paneId, text, nonce: ++draftNonce });
        else keepForLater(paneId, text);
      });
    };
    take();
    const unlisten = pointApi.onDraft((named) => {
      if (named === paneId) take();
    });
    return () => {
      unlisten();
      shown.current = null;
    };
  }, [paneId]);

  // A draft from another pane (left over from before a switch) is never returned.
  return draft && draft.paneId === paneId ? draft : null;
}
