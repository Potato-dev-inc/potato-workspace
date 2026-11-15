// The line itself: one time axis, one thin lane per project, a mark per finished turn, and a time handle.
// The handle follows the pointer (and snaps to the nearest mark at or before it in the picked lane) or the
// arrow keys. Marks are roving-tabindex buttons, so Tab visits the line once and arrows walk the marks.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useT } from '../../i18n';
import {
  buildAxis,
  clock,
  laneItems,
  markLabel,
  markOrder,
  stepLane,
  stepMark,
  type LaneView,
  type Mark,
} from './lanes-model';

/** Width used until the line has been measured (and in tests, where nothing has a size). */
const FALLBACK_WIDTH = 900;

/** The newest mark of a lane at or before a time, as the lane's tiny state label. */
export function laneState(lane: LaneView, ms: number): Mark | null {
  let found: Mark | null = null;
  for (const m of lane.marks) {
    if (m.row.atMs <= ms) found = m;
    else break;
  }
  return found;
}

export function TimelineLine({
  lanes,
  windowMs,
  nowMs,
  showNow,
  selectedId,
  handleMs,
  agentName,
  simple = false,
  onSelect,
  onHandle,
  onHandleEnd,
  onWheelZoom,
  onOpenCluster,
}: {
  lanes: LaneView[];
  windowMs: { startMs: number; endMs: number };
  nowMs: number;
  showNow: boolean;
  selectedId: string | null;
  handleMs: number | null;
  agentName: (agentType: string) => string;
  simple?: boolean;
  onSelect: (mark: Mark) => void;
  /** The handle was dragged to a time in a lane: the page snaps it to a mark. */
  onHandle: (ms: number, lane: number) => void;
  /** The pointer was let go: the handle settles on the mark it snapped to. */
  onHandleEnd: () => void;
  onWheelZoom: (direction: 'in' | 'out') => void;
  /** A busy stretch was opened, from its pill or because an arrow key reached one of its marks (`focus`). */
  onOpenCluster: (marks: Mark[], focus?: Mark) => void;
}) {
  const t = useT();
  const tracksRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(FALLBACK_WIDTH);
  const dragging = useRef(false);
  const keyNav = useRef(false);

  useLayoutEffect(() => {
    const el = tracksRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.getBoundingClientRect().width;
      if (w > 40) setWidth(Math.round(w));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const order = useMemo(() => markOrder(lanes), [lanes]);
  const axis = useMemo(() => buildAxis(order.map((m) => m.row.atMs), windowMs.startMs, windowMs.endMs, width), [order, windowMs.startMs, windowMs.endMs, width]);
  const selected = order.find((m) => m.id === selectedId) ?? null;
  // Roving tabindex: the selected mark, else the first one in view, is the line's one Tab stop.
  const tabStop = selected?.id ?? order.find((m) => m.row.atMs >= axis.startMs && m.row.atMs <= axis.endMs)?.id ?? null;

  // After an arrow key the new mark takes focus; a click leaves focus where the click put it.
  useEffect(() => {
    if (!keyNav.current || !selectedId) return;
    keyNav.current = false;
    const marks = tracksRef.current?.querySelectorAll<HTMLElement>('[data-mark-id]');
    [...(marks ?? [])].find((el) => el.dataset.markId === selectedId)?.focus();
  }, [selectedId]);

  const labelFor = (mark: Mark) => markLabel(mark, lanes[mark.lane]?.name ?? '', agentName(mark.row.agentType), t);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    let next: Mark | null = null;
    if (event.key === 'ArrowLeft') next = stepMark(order, selectedId, -1);
    else if (event.key === 'ArrowRight') next = stepMark(order, selectedId, 1);
    else if (event.key === 'ArrowUp') next = stepLane(lanes, selected, -1);
    else if (event.key === 'ArrowDown') next = stepLane(lanes, selected, 1);
    else return;
    event.preventDefault();
    if (!next) return;
    keyNav.current = true;
    // A mark inside a busy stretch has no button of its own: open the stretch, with this mark picked.
    const lane = lanes[next.lane];
    const pill = lane && laneItems(lane.marks, axis).find((i) => i.type === 'cluster' && i.marks.some((m) => m.id === next.id));
    if (pill && pill.type === 'cluster') onOpenCluster(pill.marks, next);
    else onSelect(next);
  };

  const pointerTo = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    // The first row is the ticks; lanes follow, each 28 px.
    const lane = Math.min(lanes.length - 1, Math.max(0, Math.floor((y - TICK_ROW) / LANE_ROW)));
    onHandle(axis.msAt(x), lane);
  };

  const handleX = handleMs === null ? null : axis.xOf(handleMs);
  const nowX = showNow && nowMs >= axis.startMs && nowMs <= axis.endMs ? axis.xOf(nowMs) : null;

  return (
    <div className="ck-tl" role="group" aria-label={t('timeline.lineLabel')} onKeyDown={onKeyDown} onWheel={(e) => onWheelZoom(e.deltaY < 0 ? 'in' : 'out')}>
      <div className="ck-tl-grid">
        <div className="ck-tl-names">
          <div className="ck-tl-name ck-tl-name--ticks" aria-hidden="true" />
          {lanes.map((lane) => {
            const state = handleMs === null ? null : laneState(lane, handleMs);
            return (
              <div key={lane.project} className="ck-tl-name" title={lane.project}>
                <span className="ck-tl-name-text">{lane.name}</span>
                {state && (
                  <span className="ck-tl-state" aria-hidden="true">
                    {state.shape === 'undo' ? t('timeline.mark.wentBack') : simple || state.row.turn === 0 ? clock(state.row.atMs) : `${t('timeline.mark.turn', { n: state.row.turn })}, ${clock(state.row.atMs)}`}
                  </span>
                )}
              </div>
            );
          })}
        </div>
        <div
          className="ck-tl-tracks"
          ref={tracksRef}
          onPointerDown={(e) => {
            if ((e.target as HTMLElement).closest('.ck-tl-mark, .ck-tl-cluster')) return;
            dragging.current = true;
            e.currentTarget.setPointerCapture?.(e.pointerId);
            pointerTo(e);
          }}
          onPointerMove={(e) => dragging.current && pointerTo(e)}
          onPointerUp={(e) => {
            if (dragging.current) onHandleEnd();
            dragging.current = false;
            e.currentTarget.releasePointerCapture?.(e.pointerId);
          }}
        >
          <div className="ck-tl-ticks" aria-hidden="true">
            {axis.ticks
              // The handle's own time chip sits on the ticks row: a tick it would cover is left out.
              .filter((tick) => handleX === null || Math.abs(tick.x - handleX) > CHIP_CLEARANCE_PX)
              .map((tick) => (
                <span key={tick.ms} className="ck-tl-tick" style={{ left: tick.x }}>
                  {clock(tick.ms)}
                </span>
              ))}
            {nowX !== null && (handleX === null || Math.abs(nowX - handleX) > CHIP_CLEARANCE_PX) && (
              <span className="ck-tl-tick ck-tl-tick--now" style={{ left: nowX }}>
                {t('timeline.now')}
              </span>
            )}
          </div>
          {lanes.map((lane, laneIndex) => (
            <div key={lane.project} className="ck-tl-lane" role="presentation" data-lane={laneIndex} aria-label={t('timeline.lane', { project: lane.name })}>
              <span className="ck-tl-rail" aria-hidden="true" />
              {axis.folds.map((fold) => (
                <span key={fold.fromMs} className="ck-tl-fold" style={{ left: fold.x0, width: fold.x1 - fold.x0 }} title={t('timeline.fold')} aria-hidden="true" />
              ))}
              {laneItems(lane.marks, axis).map((item) =>
                item.type === 'mark' ? (
                  <button
                    key={item.mark.id}
                    type="button"
                    className="ck-tl-mark"
                    data-mark-id={item.mark.id}
                    data-shape={item.mark.shape}
                    data-faded={item.mark.faded ? 'true' : undefined}
                    data-branch={item.mark.branch ? 'true' : undefined}
                    data-helper={item.mark.helper ? 'true' : undefined}
                    aria-pressed={item.mark.id === selectedId}
                    aria-label={labelFor(item.mark)}
                    title={`${labelFor(item.mark)}${item.mark.row.note ? `: ${item.mark.row.note}` : ''}`}
                    tabIndex={item.mark.id === tabStop ? 0 : -1}
                    style={{ left: item.x }}
                    onClick={() => onSelect(item.mark)}
                  >
                    <span className="ck-tl-dot" />
                  </button>
                ) : (
                  <button
                    key={item.marks[0].id}
                    type="button"
                    className="ck-tl-cluster"
                    style={{ left: item.x0, width: Math.max(28, item.x1 - item.x0) }}
                    aria-label={t('timeline.cluster', { count: item.marks.length, from: clock(item.marks[0].row.atMs), to: clock(item.marks[item.marks.length - 1].row.atMs) })}
                    onClick={() => onOpenCluster(item.marks)}
                  >
                    {item.marks.length}
                  </button>
                ),
              )}
            </div>
          ))}
          {handleX !== null && (
            <div className="ck-tl-handle" style={{ left: handleX }} aria-hidden="true">
              <span className="ck-tl-handle-time">{clock(handleMs as number)}</span>
            </div>
          )}
        </div>
      </div>
      <p className="ck-tl-hint">{t('timeline.handleHint')}</p>
    </div>
  );
}

/** How far a tick label stays from the handle's time chip. */
const CHIP_CLEARANCE_PX = 38;

/** Row heights the pointer maths shares with the CSS (cockpit-timeline.css). */
export const TICK_ROW = 22;
export const LANE_ROW = 28;
