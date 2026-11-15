// The drop target for the whole work area while an agent is dragged (a sidebar row, a helper chip or a pane header),
// with a live preview that follows the pointer: the half the dragged agent will take, the half that stays, the
// centre line, and a hint. Mount inside `.ck-main` (it is position: relative). Esc and a release outside are handled
// by the drag layer (dragStore.ts): nothing changes. The zone rules live in work-drop.ts.
import '../../styles/cockpit-dnd.css';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { useT } from '../../i18n';
import { registerDropZone, useDrag } from './dragStore';
import { useRegisterAction } from '../../whatsnew/registry';
import { dropColumn, dropZone, planDrop, previewBoxes, type Box, type WorkDropColumn, type WorkDropZone } from './work-drop';

export const WORK_DROP_ID = 'work';
/** "Try it" on the split tip: the half-and-half preview stays up this long. */
export const SPLIT_TIP_MS = 4500;

const boxStyle = (b: Box): CSSProperties => ({ left: `${b.left}%`, top: `${b.top}%`, width: `calc(${b.width}% - 12px)`, height: `calc(${b.height}% - 12px)`, margin: 6 });

export function WorkAreaDrop({
  shown,
  remembered,
  partnerOf,
  nameOf,
  onDrop,
}: {
  /** The chats on screen now (split-grid.ts shownIds). */
  shown: readonly string[];
  /** The left side's share the person last left. */
  remembered: number;
  /** The chat that comes to the front when the only open chat is dragged (null: none). */
  partnerOf: (draggedId: string) => string | null;
  nameOf: (id: string) => string;
  onDrop: (id: string, zone: WorkDropZone, column: WorkDropColumn) => void;
}) {
  const t = useT();
  const drag = useDrag();
  const el = useRef<HTMLDivElement>(null);
  // What's new "Try it": show the half-and-half preview with a tip, with no drag, for a few seconds.
  const [tip, setTip] = useState(false);
  useRegisterAction('split.hint', () => {
    setTip(true);
  });
  useEffect(() => {
    if (!tip) return;
    const off = window.setTimeout(() => setTip(false), SPLIT_TIP_MS);
    return () => window.clearTimeout(off);
  }, [tip]);
  const handler = useRef(onDrop);
  handler.current = onDrop;
  useEffect(
    () =>
      registerDropZone({
        id: WORK_DROP_ID,
        accepts: (p) => p.kind === 'chat' || p.kind === 'tab',
        getRect: () => el.current?.getBoundingClientRect() ?? null,
        onDrop: (p, point) => {
          const r = el.current?.getBoundingClientRect();
          if (r) handler.current(p.id, dropZone(point.x, point.y, r), dropColumn(point.x, r));
        },
      }),
    [],
  );
  const dragging = drag !== null && (drag.payload.kind === 'chat' || drag.payload.kind === 'tab');
  // The helpers bar stays above the work area and the session panel stays beside it: the drop target is what is left.
  useLayoutEffect(() => {
    const box = el.current;
    const main = box?.parentElement;
    if (!box || !main) return;
    const bar = main.querySelector('[data-testid="helpers-bar"]');
    const mainBox = main.getBoundingClientRect();
    const rail = main.querySelector('[data-testid="session-rail"]');
    box.style.top = bar ? `${Math.max(0, bar.getBoundingClientRect().bottom - mainBox.top)}px` : '0px';
    box.style.right = rail ? `${Math.max(0, mainBox.right - rail.getBoundingClientRect().left)}px` : '0px';
  }, [dragging, tip]);
  if (tip && !dragging) {
    const boxes = previewBoxes('mid', remembered);
    return (
      <div ref={el} className="ck-workdrop" data-testid="work-drop-tip" data-zone="mid" aria-hidden="true">
        <div className="ck-workdrop-box is-stay" style={boxStyle(boxes.stay)}>
          <span>{t('dnd.stays')}</span>
        </div>
        <div className="ck-workdrop-box is-take" style={boxStyle(boxes.take)}>
          <span>{t('dnd.halfAndHalf')}</span>
        </div>
        <div className="ck-workdrop-mid is-on">
          <i>{t('dnd.midLine')}</i>
        </div>
        <div className="ck-workdrop-hint">{t('dnd.tryHint')}</div>
      </div>
    );
  }
  if (!drag || !dragging) return null;
  const rect = el.current?.getBoundingClientRect() ?? null;
  const over = drag.over === WORK_DROP_ID && rect !== null;
  const zone = over ? dropZone(drag.x, drag.y, rect) : null;
  const column = over ? dropColumn(drag.x, rect) : 'right';
  const plan = zone ? planDrop({ shown, id: drag.payload.id, zone, column, remembered, partner: partnerOf(drag.payload.id) }) : null;
  const boxes = zone ? previewBoxes(zone, remembered) : null;
  const name = drag.payload.label;
  const label = zone
    ? [name, zone === 'mid' ? t('dnd.halfAndHalf') : zone === 'down' ? t('dnd.below') : null, plan?.replaced ? t('dnd.replaces', { name: nameOf(plan.replaced) }) : null].filter(Boolean).join(' · ')
    : '';
  return (
    <div ref={el} className="ck-workdrop" data-testid="work-drop" data-zone={zone ?? ''} aria-hidden="true">
      {zone && boxes && (
        <>
          <div className="ck-workdrop-box is-stay" data-testid="drop-stay" style={boxStyle(boxes.stay)}>
            <span>{zone === 'down' ? t('dnd.staysTop') : t('dnd.stays')}</span>
          </div>
          <div className="ck-workdrop-box is-take" data-testid="drop-take" style={boxStyle(boxes.take)}>
            <span>{label}</span>
          </div>
          {zone !== 'down' && (
            <div className={`ck-workdrop-mid${zone === 'mid' ? ' is-on' : ''}`} data-testid="drop-midline">
              <i>{t('dnd.midLine')}</i>
            </div>
          )}
          <div className="ck-workdrop-hint" data-testid="drop-hint">
            {t('dnd.hint')}
          </div>
        </>
      )}
    </div>
  );
}
