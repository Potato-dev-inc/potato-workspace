// Two drop zones over the work area while a chat is dragged: left half, right half. Mount inside `.ck-main`
// (it is position: relative). Dropping calls `onDropChat(id, side)`.
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
        accepts: (p) => p.kind === 'chat',
        getRect: () => ref.current?.getBoundingClientRect() ?? null,
        onDrop: (p) => onDrop.current(p.id, side),
      });
    const offs = [mk('left', left), mk('right', right)];
    return () => offs.forEach((off) => off());
  }, []);
  if (!drag || drag.payload.kind !== 'chat') return null;
  return (
    <div className="ck-dropzones" aria-hidden="true">
      <div ref={left} className={`ck-dropzone${drag.over === 'work-left' ? ' is-over' : ''}`} data-testid="dropzone-left">
        <span className="ck-dropzone-label">{t('sidebar.dropLeft')}</span>
      </div>
      <div ref={right} className={`ck-dropzone${drag.over === 'work-right' ? ' is-over' : ''}`} data-testid="dropzone-right">
        <span className="ck-dropzone-label">{t('sidebar.dropRight')}</span>
      </div>
    </div>
  );
}
