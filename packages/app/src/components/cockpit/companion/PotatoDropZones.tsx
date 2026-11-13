// While Potato is dragged from the companion row, every agent it can land on (a sidebar row, a chat pane, a board tile)
// becomes a drop zone. The zones are found in the page when the drag starts, so rows and panes need no code of their own:
// they already carry `data-pane-row` / `data-pane-id`.
import { useEffect } from 'react';
import { registerDropZone, useDrag } from '../../dnd/dragStore';
import { isCompanionPaneId } from './model';

export const POTATO_KIND = 'potato';
const TARGETS = '[data-pane-row], [data-pane-id]';

const paneOf = (el: Element): string | null => el.getAttribute('data-pane-row') ?? el.getAttribute('data-pane-id');

export function PotatoDropZones({ onDropOn }: { onDropOn: (paneId: string) => void }) {
  const drag = useDrag();
  const active = drag?.payload.kind === POTATO_KIND;
  const over = active ? drag?.over : null;

  useEffect(() => {
    if (!active) return undefined;
    const offs: Array<() => void> = [];
    document.querySelectorAll(TARGETS).forEach((el, i) => {
      const paneId = paneOf(el);
      if (!paneId || isCompanionPaneId(paneId)) return;
      el.setAttribute('data-potato-target', '');
      offs.push(
        registerDropZone({
          id: `potato:${i}:${paneId}`,
          accepts: (p) => p.kind === POTATO_KIND,
          getRect: () => (el.isConnected ? el.getBoundingClientRect() : null),
          onDrop: () => onDropOn(paneId),
        }),
      );
    });
    return () => {
      offs.forEach((off) => off());
      document.querySelectorAll('[data-potato-target]').forEach((el) => {
        el.removeAttribute('data-potato-target');
        el.removeAttribute('data-potato-over');
      });
    };
  }, [active, onDropOn]);

  useEffect(() => {
    document.querySelectorAll('[data-potato-over]').forEach((el) => el.removeAttribute('data-potato-over'));
    if (!over?.startsWith('potato:')) return;
    const paneId = over.split(':').slice(2).join(':');
    document.querySelectorAll(TARGETS).forEach((el) => {
      if (paneOf(el) === paneId) el.setAttribute('data-potato-over', '');
    });
  }, [over]);

  return null;
}
