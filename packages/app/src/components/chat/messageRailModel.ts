// What the message rail draws, as plain data: one entry per message (the person's and each of the agent's replies),
// where the dashes go for a given height, and which entry the Alt+Up / Alt+Down keys move to. No DOM in here.
import type { ChatTurn } from '../../lib/sessionChatModel';
import type { ChatViewMode } from './chatViewMode';

export interface RailEntry {
  /** The item id; the message's element on the page carries it as `data-rail-id`. */
  id: string;
  turnId: string;
  who: 'you' | 'agent';
  text: string;
}

/** The messages of a chat in order. Summary shows only the agent's final answers, so the rail lists only those too. */
/** `userText`: another text for a user message (a workflow's brief is one card, so the rail shows the person's own words). */
export function buildRailEntries(turns: readonly ChatTurn[], mode: ChatViewMode, userText?: ReadonlyMap<string, string>): RailEntry[] {
  const out: RailEntry[] = [];
  for (const turn of turns) {
    if (turn.user) out.push({ id: turn.user.id, turnId: turn.id, who: 'you', text: userText?.get(turn.user.id) ?? turn.user.text });
    for (const step of turn.steps) {
      if (step.kind !== 'text') continue;
      if (mode === 'summary' && !step.item.finalAnswer) continue;
      if (step.item.text.trim() === '') continue;
      out.push({ id: step.id, turnId: turn.id, who: 'agent', text: step.item.text });
    }
  }
  return out;
}

/** Under this many messages the rail is not worth its width. */
export const RAIL_MIN_MESSAGES = 4;
/** The widest gap between two dashes, the narrowest one that still reads as separate dashes, and the room kept at both ends. */
export const RAIL_MAX_GAP = 7;
export const RAIL_MIN_GAP = 3;
export const RAIL_PAD = 12;

export interface RailSlot {
  /** Distance of the dash from the top of the rail, in pixels. */
  top: number;
  /** The entry the dash stands for (the middle one of its share when the chat is too long for one dash each). */
  index: number;
  /** The first and the last entry of its share. */
  from: number;
  to: number;
}

/**
 * The dashes for `count` messages in a rail `height` pixels tall. Spacing is even; it shrinks down to `RAIL_MIN_GAP`;
 * past that the dashes sample the chat evenly (each stands for a share of it), so the stack never overflows.
 */
export function railSlots(count: number, height: number): RailSlot[] {
  if (count <= 0) return [];
  const room = Math.max(0, height - RAIL_PAD * 2);
  const fit = Math.max(1, Math.floor(room / RAIL_MIN_GAP) + 1);
  const slots = Math.min(count, fit);
  const gap = slots > 1 ? Math.min(RAIL_MAX_GAP, room / (slots - 1)) : 0;
  const start = (height - gap * (slots - 1)) / 2;
  const out: RailSlot[] = [];
  for (let i = 0; i < slots; i++) {
    const from = Math.round((i * count) / slots);
    const to = Math.max(from, Math.round(((i + 1) * count) / slots) - 1);
    out.push({ top: start + i * gap, index: slots === count ? i : Math.min(count - 1, Math.floor((from + to) / 2)), from, to });
  }
  return out;
}

/** The dash nearest to `y`. */
export function slotAt(slots: readonly RailSlot[], y: number): number {
  let best = 0;
  let distance = Infinity;
  for (let i = 0; i < slots.length; i++) {
    const d = Math.abs(slots[i].top - y);
    if (d < distance) {
      distance = d;
      best = i;
    }
  }
  return best;
}

/** The dash that stands for entry `index`. */
export function slotOfEntry(slots: readonly RailSlot[], index: number): number {
  const i = slots.findIndex((slot) => index >= slot.from && index <= slot.to);
  return i < 0 ? Math.max(0, slots.length - 1) : i;
}

/** The person's own message before (`-1`) or after (`1`) entry `from`, or null when there is none that way. */
export function neighbourOwn(entries: readonly RailEntry[], from: number, direction: -1 | 1): number | null {
  for (let i = from + direction; i >= 0 && i < entries.length; i += direction) if (entries[i].who === 'you') return i;
  return null;
}

/** The entries whose text holds `query` (case does not matter). An empty query matches nothing. */
export function railMatches(entries: readonly RailEntry[], query: string): Set<number> {
  const needle = query.trim().toLowerCase();
  const hits = new Set<number>();
  if (needle === '') return hits;
  entries.forEach((entry, i) => {
    if (entry.text.toLowerCase().includes(needle)) hits.add(i);
  });
  return hits;
}
