// The ghost card that follows the pointer, plus a screen-reader line. Mount once inside the cockpit.
import '../../styles/cockpit-dnd.css';
import { useT } from '../../i18n';
import { useDrag } from './dragStore';
import { useAnnouncement } from './announce';

export function DragLayer() {
  const t = useT();
  const drag = useDrag();
  const said = useAnnouncement();
  // The spoken message stays mounted so a screen reader hears each change.
  if (!drag)
    return (
      <div className="ck-sr-only" role="status" aria-live="polite">
        {said}
      </div>
    );
  return (
    <>
      <div className="ck-drag-ghost" style={{ transform: `translate(${drag.x + 14}px, ${drag.y + 14}px)` }} aria-hidden="true" data-testid="drag-ghost">
        {drag.payload.label}
      </div>
      {drag.line && (
        <div
          className="ck-drop-line"
          style={{ left: drag.line.left, top: drag.line.top, width: drag.line.width, height: drag.line.height }}
          aria-hidden="true"
          data-testid="drop-line"
        />
      )}
      <div className="ck-sr-only" role="status">
        {t(drag.payload.kind === 'chat' ? 'sidebar.dragLive' : 'dnd.dragLive', { name: drag.payload.label })}
      </div>
    </>
  );
}
