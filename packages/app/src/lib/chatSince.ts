// "New since you looked": what a chat gained since the person last had it open and at its end. The moment of the last
// look is kept per chat in this window's storage. Pure helpers plus the small storage; the line itself is
// components/chat/SinceLine.tsx.
import type { ChatTurn, ToolStep, TurnStep } from './sessionChatModel';
import { changedFiles } from './turnPrice';

const KEY = 'pm-chat-seen:';

export function readSeen(chatId: string, storage: Pick<Storage, 'getItem'> | null = safeStorage()): number | null {
  try {
    const raw = storage?.getItem(KEY + chatId);
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function writeSeen(chatId: string, ms: number, storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  try {
    storage?.setItem(KEY + chatId, String(Math.round(ms)));
  } catch {
    /* storage is off (private mode): the line simply does not show next time */
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function atMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** When a step happened, in ms, or null when it has no time. */
function stepAt(step: TurnStep): number | null {
  return step.kind === 'tool' ? atMs(step.call.at) : atMs(step.item.at);
}

export interface SinceReport {
  /** The id of the first turn that holds something newer than `seen`: the line goes above it. */
  firstTurnId: string;
  /** Answers (finished turns) that ended after `seen`. */
  answers: number;
  /** Files changed after `seen`, each once. */
  files: number;
}

/** What is newer than `seen` (ms), or null when nothing is. Needs the items' own times; one with no time counts as old. */
export function sinceReport(turns: readonly ChatTurn[], seen: number): SinceReport | null {
  let firstTurnId: string | null = null;
  let answers = 0;
  const files = new Set<string>();
  for (const turn of turns) {
    const newSteps = turn.steps.filter((step) => (stepAt(step) ?? 0) > seen);
    const endedAt = atMs(turn.end?.at);
    const userAt = atMs(turn.user?.at);
    const fresh = newSteps.length > 0 || (endedAt ?? 0) > seen || (userAt ?? 0) > seen;
    if (!fresh) continue;
    firstTurnId ??= turn.id;
    if ((endedAt ?? 0) > seen) answers += 1;
    for (const path of changedFiles(newSteps.filter((step): step is ToolStep => step.kind === 'tool'))) files.add(path);
  }
  return firstTurnId === null ? null : { firstTurnId, answers, files: files.size };
}
