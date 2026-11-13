// Drop zones over the work area while something is dragged: a chat gets a left half and a right half; a pane tab
// gets the right edge only (drop it there to split). Mount inside `.ck-main` (it is position: relative).
// Dropping calls `onDropChat(id, side)`; a tab's id is its pane's id, so it is the same call.
import '../../styles/cockpit-dnd.css';
import { useEffect, useRef } from 'react';
import { useT } from '../../i18n';
import { registerDropZone, useDrag } from './dragStore';
import type { DropSide } from './drop-split';

export function WorkAreaDropZones({ onDropChat }: { onDropChat: (id: string, side: DropSide) => void }) {
  const t = useT();
  const drag = useDrag();
  const left = useRef<HTMLDivElement>(null);
  const right = useRef<HTMLDivElement>(null);
  const onDrop = useRef(onDropChat);
  onDrop.current = onDropChat;
  useEffect(() => {
    const mk = (side: DropSide, ref: { current: HTMLDivElement | null }) =>
      registerDropZone({
        id: `work-${side}`,
        accepts: (p) => p.kind === 'chat' || (p.kind === 'tab' && side === 'right'),
        getRect: () => ref.current?.getBoundingClientRect() ?? null,
        onDrop: (p) => onDrop.current(p.id, side),
      });
    const offs = [mk('left', left), mk('right', right)];
    return () => offs.forEach((off) => off());
  }, []);
  if (!drag || (drag.payload.kind !== 'chat' && drag.payload.kind !== 'tab')) return null;
  const edge = drag.payload.kind === 'tab';
  return (
    <div className={`ck-dropzones${edge ? ' ck-dropzones--edge' : ''}`} aria-hidden="true">
      {/* A tab has no left zone, but the ref stays valid so the zone list is the same for both. */}
      <div ref={left} className={`ck-dropzone${drag.over === 'work-left' ? ' is-over' : ''}`} data-testid="dropzone-left" hidden={edge}>
        <span className="ck-dropzone-label">{t('sidebar.dropLeft')}</span>
      </div>
      <div ref={right} className={`ck-dropzone${drag.over === 'work-right' ? ' is-over' : ''}`} data-testid="dropzone-right">
        <span className="ck-dropzone-label">{t('sidebar.dropRight')}</span>
      </div>
    </div>
  );
}
