// The ghost card that follows the pointer, plus a screen-reader line. Mount once inside the cockpit.
import '../../styles/cockpit-dnd.css';
import { useT } from '../../i18n';
import { useDrag } from './dragStore';

export function DragLayer() {
  const t = useT();
  const drag = useDrag();
  if (!drag) return null;
  return (
    <>
      <div className="ck-drag-ghost" style={{ transform: `translate(${drag.x + 14}px, ${drag.y + 14}px)` }} aria-hidden="true" data-testid="drag-ghost">
        {drag.payload.label}
      </div>
      <div className="ck-sr-only" role="status">
        {t('sidebar.dragLive', { name: drag.payload.label })}
      </div>
    </>
  );
}
