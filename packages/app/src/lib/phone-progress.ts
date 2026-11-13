// The live progress line of the phone (P11): one line that says what the agent is doing now, which step it is on and how
// long it has worked. It is worked out from the chat the phone already reads, so no new route is needed. Where an agent gives
// no steps (a chat read off the terminal screen), the line has only the time and the last action. The same note is kept per
// chat so the drawer row can show it. Pure code (the store at the bottom is the only state).
import { useSyncExternalStore } from 'react';
import type { ChatSource, ChatTurn, ToolStep } from './sessionChatModel';

export type ActionKind = 'tool' | 'thinking' | 'writing' | 'none';

/** What the agent is doing, without any words of ours (the view adds the words so they follow the language). */
export interface ProgressNote {
  actionKind: ActionKind;
  /** The tool and what it works on ("Edit src/a.ts"), for `actionKind: 'tool'`. */
  action: string | null;
  /** How many tool steps the turn has run so far; null when the agent's steps are not known. */
  step: number | null;
  /** When the turn started (ms since the epoch). */
  startedAt: number;
}

const MAX_ACTION_CHARS = 80;

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_ACTION_CHARS ? `${flat.slice(0, MAX_ACTION_CHARS - 1).trimEnd()}…` : flat;
}

function toolWords(step: ToolStep): string {
  return oneLine([step.call.name, step.call.summary].filter((part) => part && part.trim() !== '').join(' '));
}

/** When each live turn was first seen by this phone, for a turn whose first message has no time. */
const firstSeen = new Map<string, number>();

/**
 * The note for the turn that is running now, or null when the last turn has ended (or there is none). `now` is only used
 * to remember when a turn without a time was first seen.
 */
export function progressOf(turns: readonly ChatTurn[], source: ChatSource | null, now: number): ProgressNote | null {
  const turn = turns[turns.length - 1];
  if (!turn || turn.end !== null) return null;
  const parsed = turn.user?.at ? Date.parse(turn.user.at) : NaN;
  if (!Number.isFinite(parsed) && !firstSeen.has(turn.id)) firstSeen.set(turn.id, now);
  if (firstSeen.size > 200) firstSeen.delete(firstSeen.keys().next().value as string);
  const startedAt = Number.isFinite(parsed) ? parsed : (firstSeen.get(turn.id) ?? now);
  const tools = turn.steps.filter((s): s is ToolStep => s.kind === 'tool' && !s.call.helper);
  const last = turn.steps[turn.steps.length - 1];
  let actionKind: ActionKind = 'none';
  let action: string | null = null;
  if (last?.kind === 'tool') {
    actionKind = 'tool';
    action = toolWords(last);
  } else if (last?.kind === 'thinking') {
    actionKind = 'thinking';
  } else if (last?.kind === 'text') {
    actionKind = 'writing';
  }
  // Steps are counted only where the agent gave real tool calls; a chat read off the screen has none to trust.
  const step = source === 'screen' || tools.length === 0 ? null : tools.length;
  return { actionKind, action, step, startedAt };
}

/** Whole minutes between two times (never negative). */
export function minutesBetween(from: number, to: number): number {
  return Math.max(0, Math.floor((to - from) / 60000));
}

export function sameNote(a: ProgressNote | null, b: ProgressNote | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.actionKind === b.actionKind && a.action === b.action && a.step === b.step && a.startedAt === b.startedAt;
}

// ---- the notes of the chats the phone has read, for the drawer rows -------------------------------------------------

const notes = new Map<string, ProgressNote>();
const listeners = new Set<() => void>();
let version = 0;

/** Sets (or, with null, clears) the note of one chat. The drawer rows follow. */
export function publishProgress(paneId: string, note: ProgressNote | null): void {
  const had = notes.get(paneId) ?? null;
  if (sameNote(had, note)) return;
  if (note) notes.set(paneId, note);
  else notes.delete(paneId);
  version += 1;
  for (const listener of [...listeners]) listener();
}

export function progressNoteOf(paneId: string): ProgressNote | null {
  return notes.get(paneId) ?? null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The note of one chat, kept up to date. */
export function useProgressNote(paneId: string): ProgressNote | null {
  useSyncExternalStore(subscribe, () => version, () => version);
  return progressNoteOf(paneId);
}

export function resetProgressForTests(): void {
  notes.clear();
  firstSeen.clear();
  version += 1;
}
