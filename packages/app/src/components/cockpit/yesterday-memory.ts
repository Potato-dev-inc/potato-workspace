// "Continue where you left off": the open chats when the app last ran, in tab order, and the split. The start page
// offers the ones that did not come back open (and are still closed, so they can be reopened). Kept in localStorage
// next to the split memory. Every storage call is wrapped in try/catch: blocked or full storage means no memory.
import { ACP_LANE } from '../../lib/acpChat';
import type { PaneInfo } from '../../lib/tauri-types';
import { isCompanionPaneId } from './companion/model';
import { parseSplitMemory, type SplitMemory } from './split-memory';

export const YESTERDAY_KEY = 'pm.cockpit.yesterday';
/** More chats than this are not worth a card. */
export const YESTERDAY_MAX_CHATS = 20;

export interface YesterdayChat {
  /** The chat's conversation id (the same id as its chat pane). */
  id: string;
  agent: string;
  cwd: string;
  title: string | null;
}

export interface YesterdaySnapshot {
  /** When the snapshot was saved (milliseconds since 1970). */
  savedAt: number;
  /** The open chats, in tab order. */
  chats: YesterdayChat[];
  /** The split, only when both of its sides were chats. */
  split: SplitMemory | null;
}

const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** Reads stored text. Anything that is not the expected shape is dropped piece by piece, never thrown. */
export function parseYesterday(raw: string | null): YesterdaySnapshot | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { savedAt?: unknown; chats?: unknown; split?: unknown } | null;
    if (!v || typeof v !== 'object' || typeof v.savedAt !== 'number' || !Number.isFinite(v.savedAt) || !Array.isArray(v.chats)) return null;
    const seen = new Set<string>();
    const chats: YesterdayChat[] = [];
    for (const c of v.chats as Array<Record<string, unknown> | null>) {
      if (!c || !str(c.id) || !str(c.agent) || typeof c.cwd !== 'string' || seen.has(c.id)) continue;
      seen.add(c.id);
      chats.push({ id: c.id, agent: c.agent, cwd: c.cwd, title: str(c.title) ? c.title : null });
      if (chats.length >= YESTERDAY_MAX_CHATS) break;
    }
    const split = v.split ? parseSplitMemory(JSON.stringify(v.split)) : null;
    return { savedAt: v.savedAt, chats, split };
  } catch {
    return null;
  }
}

export function readYesterday(): YesterdaySnapshot | null {
  try {
    return parseYesterday(localStorage.getItem(YESTERDAY_KEY));
  } catch {
    return null;
  }
}

export function writeYesterday(snapshot: YesterdaySnapshot): void {
  try {
    localStorage.setItem(YESTERDAY_KEY, JSON.stringify(snapshot));
  } catch {
    // Storage is blocked or full: nothing is remembered for tomorrow.
  }
}

let lastRun: YesterdaySnapshot | null | undefined;

/**
 * The snapshot the previous run left. Read once, the first time it is asked, which must be before this run writes
 * its own (the snapshot hook asks on its first render).
 */
export function previousRun(): YesterdaySnapshot | null {
  if (lastRun === undefined) lastRun = readYesterday();
  return lastRun;
}

/** Tests only: forget the captured previous run so the next call reads storage again. */
export function forgetPreviousRunForTests(): void {
  lastRun = undefined;
}

/** A chat pane (not a terminal agent, a helper, or a companion). */
export function isChatPane(info: PaneInfo): boolean {
  return info.lane === ACP_LANE && !info.parent_pane_id && !isCompanionPaneId(info.id);
}

/** The snapshot of the chats open now. The split is kept only when both of its sides are open chats. */
export function snapshotNow(panes: readonly PaneInfo[], split: SplitMemory | null, now: number): YesterdaySnapshot {
  const chats: YesterdayChat[] = panes
    .filter(isChatPane)
    .slice(0, YESTERDAY_MAX_CHATS)
    .map((info) => ({ id: info.id, agent: info.agent_type, cwd: info.cwd ?? '', title: info.title?.trim() || null }));
  const ids = new Set(chats.map((c) => c.id));
  const keepSplit = split && ids.has(split.left) && ids.has(split.right) ? split : null;
  return { savedAt: now, chats, split: keepSplit };
}

/**
 * The chats to offer: in the snapshot, not open now, and still closed (so they can be reopened). A chat that was
 * deleted for good is in neither list and is not offered.
 */
export function pendingChats(snapshot: YesterdaySnapshot | null, openIds: ReadonlySet<string>, closedIds: ReadonlySet<string>): YesterdayChat[] {
  if (!snapshot) return [];
  return snapshot.chats.filter((c) => !openIds.has(c.id) && closedIds.has(c.id));
}

const sameDay = (a: Date, b: Date): boolean => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** Which day a saved time falls on, relative to `now`: "today", "yesterday", or null (use the date itself). */
export function dayWordOf(savedAt: number, now: number): 'today' | 'yesterday' | null {
  const saved = new Date(savedAt);
  const today = new Date(now);
  if (sameDay(saved, today)) return 'today';
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  return sameDay(saved, yesterday) ? 'yesterday' : null;
}
