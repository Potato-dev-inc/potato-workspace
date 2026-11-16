// Inbox > "By urgency" (the default) or "By crew". Pure grouping plus the remembered choice.
import { inboxRank, type InboxEntry } from './inbox-order';

export type InboxView = 'urgency' | 'crew';
const KEY = 'pm.inbox.view';

export function readInboxView(): InboxView {
  try {
    return window.localStorage.getItem(KEY) === 'crew' ? 'crew' : 'urgency';
  } catch {
    return 'urgency';
  }
}
export function saveInboxView(view: InboxView): void {
  try {
    window.localStorage.setItem(KEY, view);
  } catch {
    /* not remembered */
  }
}

/** Risky asks and consent stay on top in both views: they never hide inside a group. */
export const isPinned = (e: InboxEntry): boolean => inboxRank(e.kind, e.risk) === 0;

/** The chat that started this one, followed up the tree (an unknown or closed parent ends the walk). */
export function rootOf(paneId: string, parentOf: (id: string) => string | null | undefined): string {
  let at = paneId;
  for (let hops = 0; hops < 32; hops++) {
    const parent = parentOf(at);
    if (!parent || parent === at) break;
    at = parent;
  }
  return at;
}

export interface InboxGroup<T> {
  /** The chat that started the group's helpers, or null for cards that belong to no chat. */
  root: string | null;
  entries: T[];
}

/** Pinned cards first (their order kept), then one group per starting chat, in the order of its most urgent card. */
export function groupInbox<T extends InboxEntry & { paneId?: string }>(
  sorted: ReadonlyArray<T>,
  rootFor: (paneId: string) => string,
): { pinned: T[]; groups: InboxGroup<T>[] } {
  const pinned: T[] = [];
  const groups: InboxGroup<T>[] = [];
  for (const e of sorted) {
    if (isPinned(e)) {
      pinned.push(e);
      continue;
    }
    const root = e.paneId ? rootFor(e.paneId) : null;
    const g = groups.find((x) => x.root === root);
    if (g) g.entries.push(e);
    else groups.push({ root, entries: [e] });
  }
  // Cards of no chat go last.
  groups.sort((a, b) => Number(a.root === null) - Number(b.root === null));
  return { pinned, groups };
}
