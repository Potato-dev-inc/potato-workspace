import { paneTurns } from './potatoCheck';

// Two small hand-offs between screens that do not know each other.
// 1. "Pass to a teammate…" in a chat's menu asks the cockpit to open the Pass a task sheet (pre-filled).
// 2. "Start…" on a received task leaves a draft for the New agent page: the words only go in the box. The person presses Send.

export interface PassRequest {
  /** The chat's project folder: the repo the person may send along. */
  repoPath: string | null;
  /** A short summary of the chat, when one exists. */
  summary: string;
}

type PassListener = (req: PassRequest) => void;
const passListeners = new Set<PassListener>();

export function requestPassTask(req: PassRequest): void {
  passListeners.forEach((l) => l(req));
}

export function onPassTaskRequest(l: PassListener): () => void {
  passListeners.add(l);
  return () => {
    passListeners.delete(l);
  };
}

/** A short, honest summary of a chat: what the person last asked it, cut short. Empty when the chat is not open here. Never the transcript. */
export function chatSummaryOf(paneId: string): string {
  const turns = paneTurns(paneId);
  if (!turns) return '';
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const text = turns[i].user?.text.trim();
    if (text) return text.length > 400 ? `${text.slice(0, 400)}…` : text;
  }
  return '';
}

export interface NewAgentDraft {
  text: string;
  folder: string | null;
  /** Whose words these are. */
  from: string;
}

let draft: NewAgentDraft | null = null;

/** Leaves a draft for the New agent page. Nothing starts. */
export function setNewAgentDraft(next: NewAgentDraft): void {
  draft = next;
}

/** The New agent page takes the draft once. */
export function takeNewAgentDraft(): NewAgentDraft | null {
  const d = draft;
  draft = null;
  return d;
}

export const peekNewAgentDraft = (): NewAgentDraft | null => draft;
