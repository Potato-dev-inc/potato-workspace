// The "needs you" pill above the composer (pure): another agent's open question, while you read this chat. It answers Yes or No on
// the pill only when that is safe (a low-risk approval with exactly one allow and one deny choice); anything else is a tap that
// jumps to that chat. "+N" counts the others.
import type { AttentionItem, AttentionSnapshot } from './attention';
import { buttonsFor, isDenyLabel } from './approval-card';
import { PROMPT_KINDS, isBlocking, isOpen } from './needs-you-queue';

export interface PillView {
  /** The first other agent that needs you. */
  item: AttentionItem;
  /** How many more wait, besides this one. */
  more: number;
  /** Yes and No can be pressed on the pill. */
  quick: { yes: string; no: string } | null;
}

/** The choice ids a pill may press: a low-risk approval with one allow and one deny. */
export function quickChoices(item: AttentionItem): { yes: string; no: string } | null {
  if (!PROMPT_KINDS.includes(item.kind) || item.kind === 'trust_gate') return null;
  if (item.risk?.level !== 'low') return null;
  const prompt = item.prompt;
  if (!prompt?.fingerprint || !prompt.choices) return null;
  const shown = buttonsFor(item, false);
  if (shown.length !== 2) return null;
  const choices = prompt.choices;
  const no = shown.find((b) => {
    const choice = choices.find((c) => c.id === b.id);
    return !!choice && isDenyLabel(choice);
  });
  const yes = shown.find((b) => b.role === 'primary' && b.id !== no?.id);
  return no && yes ? { yes: yes.id, no: no.id } : null;
}

/** What the pill shows while `activePaneId` is open (null when nothing else waits). */
export function pillFor(snapshot: AttentionSnapshot | null, activePaneId: string | null): PillView | null {
  if (!snapshot) return null;
  const others = snapshot.items.filter((item) => isBlocking(item) && isOpen(item) && item.pane && item.pane.id !== activePaneId);
  const first = others[0];
  if (!first) return null;
  return { item: first, more: others.length - 1, quick: quickChoices(first) };
}
