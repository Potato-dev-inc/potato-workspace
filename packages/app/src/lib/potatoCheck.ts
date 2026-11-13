// "Check on this one" (workflow proposal 37): Potato is dropped on an agent and says in two lines what it is doing and
// whether it needs anything. Pure helpers plus three tiny in-memory registries (the chats' turns, check requests, watches).
// Reading only: the question goes through the side question path (lib/sideQuestion) and nothing is written into the chat.
import type { ChatTurn } from './sessionChatModel';

/** What Potato asks. The side question wraps it as a read-only one-shot prompt. */
export const CHECK_QUESTION =
  'In two short plain lines for a non-technical person: what is this agent doing right now, and does it need anything from the person (a yes or no, an answer, a fix)? No lists, no markdown.';

/** The words "Nudge it" sends. Only ever after a click. */
export const NUDGE_TEXT = 'status?';

export const NOTED_KEY = 'pm.potato.checkNoted';

// ---- The chats' turns, by pane (set by the chat view while it is on screen) --------------------------------

const turnSources = new Map<string, () => readonly ChatTurn[]>();

/** A chat view tells where its turns are. Returns the function that forgets them. */
export function registerPaneTurns(paneId: string, read: () => readonly ChatTurn[]): () => void {
  turnSources.set(paneId, read);
  return () => {
    if (turnSources.get(paneId) === read) turnSources.delete(paneId);
  };
}

/** The turns of this pane's chat, or null when no chat view has them (a terminal agent, or a chat not opened yet). */
export function paneTurns(paneId: string): readonly ChatTurn[] | null {
  const read = turnSources.get(paneId);
  if (!read) return null;
  const turns = read();
  return turns.length > 0 ? turns : null;
}

// ---- A check requested from somewhere else (the row menu) -------------------------------------------------

const requestListeners = new Set<(paneId: string) => void>();

export function requestPotatoCheck(paneId: string): void {
  requestListeners.forEach((l) => l(paneId));
}

export function onPotatoCheckRequest(l: (paneId: string) => void): () => void {
  requestListeners.add(l);
  return () => {
    requestListeners.delete(l);
  };
}

// ---- The answer ---------------------------------------------------------------------------------------------

const stripMarkdown = (s: string): string =>
  s
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^[\s>*#-]+/gm, '')
    .replace(/[*_`]/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .trim();

/** At most two short lines out of whatever the helper wrote. */
export function twoLines(answer: string, maxChars = 160): string[] {
  const plain = stripMarkdown(answer);
  let lines = plain.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2 && lines[0]) {
    // One paragraph: cut it at sentence ends.
    lines = (lines[0].match(/[^.!?。！？]+[.!?。！？]*/g) ?? [lines[0]]).map((l) => l.trim()).filter(Boolean);
  }
  const cut = (l: string) => (Array.from(l).length > maxChars ? `${Array.from(l).slice(0, maxChars - 1).join('')}…` : l);
  return lines.slice(0, 2).map(cut);
}

export type FallbackLine = { key: 'potato.check.fallback.working' | 'potato.check.fallback.needs' | 'potato.check.fallback.error' | 'potato.check.fallback.idle' | 'potato.check.fallback.quiet'; vars?: Record<string, string> };

/** For a pane with no chat to read: one line from its status and its activity line. */
export function fallbackLine(status: string, needsYou: boolean, activity: string | null): FallbackLine {
  if (needsYou || status === 'waiting_input') return { key: 'potato.check.fallback.needs' };
  if (status === 'error') return { key: 'potato.check.fallback.error' };
  if (status === 'running') return activity ? { key: 'potato.check.fallback.working', vars: { activity } } : { key: 'potato.check.fallback.quiet' };
  return { key: 'potato.check.fallback.idle' };
}

// ---- "Watch it for me" ---------------------------------------------------------------------------------------

/** pane id -> the state it was in when the person asked: 'needs' | 'working' | 'calm'. */
export type WatchState = 'needs' | 'working' | 'calm';

export const watchStateOf = (status: string, needsYou: boolean): WatchState =>
  needsYou || status === 'waiting_input' || status === 'error' ? 'needs' : status === 'running' ? 'working' : 'calm';

/** What changed for a watched pane, or null when it is still the same. A watch fires once, then ends. */
export function watchChange(was: WatchState, now: WatchState): 'needs' | 'done' | 'working' | null {
  if (was === now) return null;
  if (now === 'needs') return 'needs';
  if (now === 'calm') return 'done';
  return was === 'calm' ? 'working' : null;
}
