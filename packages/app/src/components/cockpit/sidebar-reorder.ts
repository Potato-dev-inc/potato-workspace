// How the sidebar's reorder lists find their items on screen. A top-level chat is its row's wrapper, or the whole
// node when it has helpers under it (so a chat and its helpers are one item and move together).
import type { ReorderItem } from '../dnd/ReorderList';

/** The element that stands for the top-level chat `id` inside `box`, or null when it is not drawn. */
export function chatItemEl(box: ParentNode, id: string): Element | null {
  // Matched by comparing the attribute: an id is never put into a selector.
  const row = Array.from(box.querySelectorAll('[data-pane-row]')).find((el) => el.getAttribute('data-pane-row') === id);
  const wrap = row?.closest('.ck-rowwrap');
  if (!wrap) return null;
  return wrap.parentElement?.classList.contains('ck-node') ? wrap.parentElement : wrap;
}

/** The items for `ids`, top to bottom as they are drawn. */
export function chatItems(box: HTMLElement, ids: readonly string[]): ReorderItem[] {
  return ids
    .flatMap((id) => {
      const el = chatItemEl(box, id);
      return el ? [{ id, el }] : [];
    })
    .sort((a, b) => a.el.getBoundingClientRect().top - b.el.getBoundingClientRect().top);
}

/** The chat id of the row a focused element is in. */
export const rowIdOf = (el: Element): string | null => el.closest('[data-pane-row]')?.getAttribute('data-pane-row') ?? null;
