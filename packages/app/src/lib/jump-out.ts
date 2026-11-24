// Which blocking question jumps out over the work area (components/cockpit/JumpOutCard.tsx). Pure: every rule lives here so
// it is testable without a DOM. Input is the Inbox's own list (`blockingItems` of the needs-you items), narrowed to the kinds that
// stop an agent and that no pane dock already draws. Nothing here reads a setting or the clock itself.
import { blockingItems, type NeedsYouItem } from './attention';
import { sortInbox, type InboxRisk } from './inbox-order';
import { bubbleTargets } from './helper-questions';
import { isBudget, isCiCard, isConsent, isIssueCard, isLimit, type Question } from './questions';
import type { FarQuestion } from './runtime/farQuestions';

/** A new item waits this long before it jumps out, so a helper's question its parent answers in a moment never flashes. */
export const JUMP_GRACE_MS = 3000;

const ACP_PERMISSION = 'acp_permission';

export type JumpKind = 'approval' | 'question' | 'consent' | 'budget';

export interface JumpEntry {
  /** What "Later" hides: the question id, or `approval:<pane>:<prompt id>` (a new prompt on the same pane pops again). */
  key: string;
  /** The needs-you item id this came from. */
  itemId: string;
  kind: JumpKind;
  risk?: InboxRisk;
  since?: number;
  paneId?: string;
  question?: Question;
  far?: FarQuestion;
}

export interface JumpInput {
  needs: ReadonlyArray<NeedsYouItem>;
  /** This PC's live questions. */
  questions: ReadonlyArray<Question>;
  /** What other PCs wait on. */
  far: ReadonlyArray<FarQuestion>;
  panes: ReadonlyArray<{ info: { id: string; parent_pane_id?: string | null }; status: string }>;
  /** The current prompt id of each pane that has one drawn on screen. */
  promptIds: Readonly<Record<string, string | undefined>>;
  view: string;
  mode: string;
  enabled: boolean;
  /** The panes the main window shows right now. */
  shown: ReadonlyArray<string>;
  /** The far chat that is open (view = device), if any. */
  farOpen: { node: string; paneId: string } | null;
  hidden: ReadonlySet<string>;
  isSnoozed: (keys: string[]) => boolean;
  /** When each item id was first seen (ms); an id with no entry counts as just seen. */
  firstSeen: ReadonlyMap<string, number>;
  now: number;
}

export interface JumpPick {
  entry: JumpEntry | null;
  /** Every card that would jump out, in Inbox order (`entry` is the first): a card the person is typing in stays put while this changes. */
  ready: JumpEntry[];
  /** Other cards that would jump out too: "{n} more in Inbox". */
  more: number;
  /** Ms until the soonest item leaves its grace wait (the caller re-checks then), or null. */
  waitMs: number | null;
  /** Every key that is live right now (suppressed or not): the caller drops `hidden` keys that are not in it. */
  liveKeys: string[];
}

export const jumpOutKey = (e: Pick<JumpEntry, 'kind' | 'paneId' | 'question' | 'far'>, promptId?: string): string =>
  e.question ? e.question.id : e.far ? e.far.key : `approval:${e.paneId}:${promptId ?? ''}`;

/** Whether a pane's Chat (its own dock, or its parent's helper-question strip) already draws that pane's approval. */
function drawnByPane(paneId: string | undefined, shown: ReadonlyArray<string>, panes: JumpInput['panes']): boolean {
  if (!paneId) return false;
  return shown.includes(paneId) || bubbleTargets(panes, paneId).some((p) => shown.includes(p));
}

export function pickJumpOut(input: JumpInput): JumpPick {
  const byId = new Map(input.questions.map((q) => [q.id, q]));
  const farByKey = new Map(input.far.map((f) => [`question:${f.key}`, f]));
  const candidates: JumpEntry[] = [];
  const live: string[] = [];

  for (const item of blockingItems(input.needs)) {
    let entry: JumpEntry | null = null;
    if (item.kind === 'approval' && item.paneId) {
      const promptId = input.promptIds[item.paneId];
      // No prompt drawn yet: nothing to answer.
      if (promptId !== undefined) entry = { key: jumpOutKey({ kind: 'approval', paneId: item.paneId }, promptId), itemId: item.id, kind: 'approval', risk: item.risk, since: item.since, paneId: item.paneId };
    } else if (item.kind === 'consent' || item.kind === 'budget' || item.kind === 'question') {
      const far = farByKey.get(item.id);
      const q = byId.get(item.id.slice(item.id.indexOf(':') + 1));
      if (far) {
        // The far PC lists only its agents' own questions and permissions; anything else it names is left in the Inbox.
        if (far.kind === undefined || far.kind === ACP_PERMISSION) entry = { key: far.key, itemId: item.id, kind: 'question', since: far.seenAt, far };
      } else if (q && q.state === 'pending') {
        const kind: JumpKind | null = isConsent(q) ? 'consent' : isBudget(q) ? 'budget' : isLimit(q) || isIssueCard(q) || isCiCard(q) ? null : 'question';
        const drawn = q.kind === ACP_PERMISSION && drawnByPane(q.pane_id, input.shown, input.panes);
        if (kind && !drawn) entry = { key: q.id, itemId: item.id, kind, risk: kind === 'consent' ? 'high' : undefined, since: q.created_at_ms, paneId: q.pane_id, question: q };
      }
    }
    if (!entry) continue;
    live.push(entry.key);
    if (entry.kind === 'approval' && drawnByPane(entry.paneId, input.shown, input.panes)) continue;
    if (entry.far && input.farOpen && entry.far.node === input.farOpen.node && entry.far.paneId === input.farOpen.paneId) continue;
    candidates.push(entry);
  }

  const none = (): JumpPick => ({ entry: null, ready: [], more: 0, waitMs: null, liveKeys: live });
  if (!input.enabled || input.mode === 'individual' || input.view === 'inbox' || input.view === 'settings') return none();

  let waitMs: number | null = null;
  const ready = candidates.filter((e) => {
    if (input.hidden.has(e.key)) return false;
    const snoozeKeys = e.question ? [`q-${e.question.id}`] : e.far ? [`q-${e.far.key}`] : e.paneId ? [e.paneId] : [];
    if (snoozeKeys.length > 0 && input.isSnoozed(snoozeKeys)) return false;
    const left = JUMP_GRACE_MS - (input.now - (input.firstSeen.get(e.itemId) ?? input.now));
    if (left > 0) {
      waitMs = waitMs === null ? left : Math.min(waitMs, left);
      return false;
    }
    return true;
  });
  const sorted = sortInbox(ready);
  const [first, ...rest] = sorted;
  return { entry: first ?? null, ready: sorted, more: rest.length, waitMs, liveKeys: live };
}

/** Under this much room (CSS px) above the message box, or this column width, the card shows as one line. */
const TIGHT_HEIGHT = 170;
const TIGHT_WIDTH = 300;
/** Under this column width (CSS px) the card is only an icon row (a dot, Show, Later); under GONE it is not drawn and the Inbox badge carries it. */
const MINI_WIDTH = 140;
const GONE_WIDTH = 80;

/** Card width and form from the chat column's width and the room above its message box (all CSS px, container-based). The width never exceeds the column. */
export function jumpOutLayout(colWidth: number, room: number): { width: number; narrow: boolean; tight: boolean; mini: boolean; gone: boolean } {
  // A narrow column gets a smaller gutter so the card never spills past it.
  const gutter = colWidth < TIGHT_WIDTH ? 16 : 32;
  return {
    width: Math.max(Math.min(440, colWidth - gutter), 0),
    narrow: colWidth < TIGHT_WIDTH,
    tight: room < TIGHT_HEIGHT || colWidth < TIGHT_WIDTH,
    mini: colWidth < MINI_WIDTH,
    gone: colWidth < GONE_WIDTH,
  };
}
