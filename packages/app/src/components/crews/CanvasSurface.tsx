// The boxes of a crew and the lines between them. A box is a button: Enter selects it, the arrow keys move it, a drag moves it.
// The whole crew fits the room on open ("Fit" does it again; Ctrl + wheel zooms). Lines are drawn under the boxes (an svg)
// and carry no text of their own; their meaning is in the box labels. Box text wraps, it is never cut off.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useT } from '../../i18n';
import type { Crew } from '../../lib/crews-api';
import type { ModelNamer } from './modelNames';
import { BOX_H, BOX_W, clampZoom, edges, extent, fitZoom, keyOf, layout, problemsOf, rightsKeys, type Edge, type Spot } from './model';

const STEP = 16;
const DRAG_FROM = 4;

/** Where a line leaves one box and meets the other. */
function ends(a: Spot, b: Spot): { x1: number; y1: number; x2: number; y2: number; vertical: boolean } {
  if (b.y >= a.y + BOX_H / 2) return { x1: a.x + BOX_W / 2, y1: a.y + BOX_H, x2: b.x + BOX_W / 2, y2: b.y, vertical: true };
  if (b.y + BOX_H <= a.y + BOX_H / 2) return { x1: a.x + BOX_W / 2, y1: a.y, x2: b.x + BOX_W / 2, y2: b.y + BOX_H, vertical: true };
  const right = b.x > a.x;
  return { x1: right ? a.x + BOX_W : a.x, y1: a.y + BOX_H / 2, x2: right ? b.x : b.x + BOX_W, y2: b.y + BOX_H / 2, vertical: false };
}

function curve(a: Spot, b: Spot): string {
  const { x1, y1, x2, y2, vertical } = ends(a, b);
  if (vertical) {
    const mid = (y1 + y2) / 2;
    return `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`;
  }
  const mid = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
}

export function CanvasSurface({
  crew,
  selected,
  onSelect,
  onMove,
  problems,
  agentName,
  modelName,
  path,
  now,
  hops,
  readOnly,
  changed,
  touched,
}: {
  crew: Crew;
  selected: number | null;
  onSelect: (index: number | null) => void;
  onMove: (index: number, to: Spot) => void;
  problems: Array<{ role: string | null; message: string }>;
  agentName: (agent: string) => string;
  modelName: ModelNamer;
  /** Role ids a "Try a task" would pass through, in order (empty: none shown). */
  path: string[];
  /** The box a followed task is at in a replay (shown stronger than the rest of the way). */
  now?: string | null;
  /** Hand-overs of a followed task as "from>to" role ids; the lines between them are lit. */
  hops?: string[];
  readOnly: boolean;
  /** Lines (`from>to` role keys) drawn thick: what a proposal adds or takes away ("Change the crew by talking"). */
  changed?: string[];
  /** Boxes whose routing rules a proposal changes. */
  touched?: string[];
}) {
  const t = useT();
  const spots = layout(crew);
  const size = extent(spots);
  const [zoom, setZoom] = useState(1);
  const [drag, setDrag] = useState<{ index: number; dx: number; dy: number } | null>(null);
  const start = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const sizeRef = useRef(size);
  sizeRef.current = size;

  const fit = () => {
    const box = scroller.current;
    if (box) setZoom(fitZoom(sizeRef.current, { width: box.clientWidth, height: box.clientHeight }));
  };
  // The whole crew fits when the canvas opens (and again whenever a crew is opened in it).
  useLayoutEffect(fit, []);
  // Ctrl + wheel zooms. A listener of its own, because a wheel handler in React cannot stop the page from zooming.
  useEffect(() => {
    const box = scroller.current;
    if (!box) return undefined;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setZoom((z) => clampZoom(z * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
    };
    box.addEventListener('wheel', onWheel, { passive: false });
    return () => box.removeEventListener('wheel', onWheel);
  }, []);

  const at = (key: string): Spot => {
    const base = spots.get(key) ?? { x: 0, y: 0 };
    const d = drag && keyOf(crew.roles[drag.index]) === key ? drag : null;
    return d ? { x: Math.max(0, base.x + d.dx), y: Math.max(0, base.y + d.dy) } : base;
  };
  const lines: Edge[] = edges(crew);

  const down = (index: number, e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    start.current = { x: e.clientX, y: e.clientY, moved: false };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    onSelect(index);
  };
  const move = (index: number, e: PointerEvent<HTMLDivElement>) => {
    const s = start.current;
    if (!s || readOnly) return;
    const dx = (e.clientX - s.x) / zoom;
    const dy = (e.clientY - s.y) / zoom;
    if (!s.moved && Math.hypot(dx, dy) * zoom < DRAG_FROM) return;
    s.moved = true;
    setDrag({ index, dx, dy });
  };
  const up = (index: number) => {
    const s = start.current;
    start.current = null;
    if (s?.moved && drag) onMove(index, at(keyOf(crew.roles[index])));
    setDrag(null);
  };
  const key = (index: number, e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect(index);
      return;
    }
    const delta: Record<string, [number, number]> = { ArrowLeft: [-STEP, 0], ArrowRight: [STEP, 0], ArrowUp: [0, -STEP], ArrowDown: [0, STEP] };
    const d = delta[e.key];
    if (!d || readOnly) return;
    e.preventDefault();
    const now = at(keyOf(crew.roles[index]));
    onMove(index, { x: Math.max(0, now.x + d[0]), y: Math.max(0, now.y + d[1]) });
  };

  return (
    <div className="crewc-stage">
      <div className="crewc-zoom" role="group" aria-label={t('crewcanvas.zoom')}>
        <button type="button" className="crewc-btn crewc-btn--small" onClick={() => setZoom((z) => clampZoom(z / 1.2))} aria-label={t('crewcanvas.zoomOut')}>
          −
        </button>
        <button type="button" className="crewc-btn crewc-btn--small" onClick={fit}>
          {t('crewcanvas.fit')}
        </button>
        <button type="button" className="crewc-btn crewc-btn--small" onClick={() => setZoom((z) => clampZoom(z * 1.2))} aria-label={t('crewcanvas.zoomIn')}>
          +
        </button>
      </div>
      <div className="crewc-scroll" ref={scroller} onMouseDown={(e) => e.target === e.currentTarget && onSelect(null)}>
        <div style={{ width: size.width * zoom, height: size.height * zoom }}>
          <div
            className="crewc-surface"
            role="group"
            aria-label={t('crewcanvas.surface')}
            data-zoom={zoom}
            style={{ width: size.width, height: size.height, transform: `scale(${zoom})`, transformOrigin: '0 0' }}
          >
            <svg className="crewc-lines" width={size.width} height={size.height} aria-hidden="true">
              <defs>
                <marker id="crewc-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" className="crewc-arrow" />
                </marker>
                <marker id="crewc-arrow-changed" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" className="crewc-arrow-changed" />
                </marker>
              </defs>
              {lines.map((l) => (
                <path
                  key={`${l.from}>${l.to}`}
                  d={curve(at(l.from), at(l.to))}
                  className={`crewc-line is-${l.kind}${hops?.includes(`${l.from}>${l.to}`) || hops?.includes(`${l.to}>${l.from}`) ? ' is-lit' : ''}${changed?.includes(`${l.from}>${l.to}`) ? ' is-changed' : ''}`}
                  data-edge={l.kind}
                  markerEnd={changed?.includes(`${l.from}>${l.to}`) ? 'url(#crewc-arrow-changed)' : l.kind === 'team' ? undefined : 'url(#crewc-arrow)'}
                />
              ))}
            </svg>
            {crew.roles.map((role, index) => {
              const k = keyOf(role);
              const spot = at(k);
              const own = problemsOf(problems, role);
              const step = path.indexOf(k);
              const classes = ['crewc-box', selected === index ? 'is-selected' : '', step >= 0 ? 'is-on-path' : '', now === k ? 'is-now' : '', touched?.includes(k) ? 'is-touched' : '', own.length ? 'has-problem' : '', drag?.index === index ? 'is-dragging' : '']
                .filter(Boolean)
                .join(' ');
              const model = modelName(role.agent_type, role.model);
              const rights = rightsKeys(role.permissions).filter((r) => r !== 'read');
              return (
                <div
                  key={k}
                  role="button"
                  tabIndex={0}
                  aria-pressed={selected === index}
                  data-testid="crew-box"
                  data-role={k}
                  className={classes}
                  style={{ left: spot.x, top: spot.y, width: BOX_W, minHeight: BOX_H }}
                  onClick={() => onSelect(index)}
                  onPointerDown={(e) => down(index, e)}
                  onPointerMove={(e) => move(index, e)}
                  onPointerUp={() => up(index)}
                  onPointerCancel={() => up(index)}
                  onKeyDown={(e) => key(index, e)}
                >
                  <span className="crewc-box-top">
                    <span className="crewc-box-name">{role.name}</span>
                    {!role.parent ? <span className="crewc-tag">{t('crewcanvas.box.lead')}</span> : null}
                    {role.check ? <span className="crewc-tag">{t('crewcanvas.box.checks')}</span> : null}
                    {step >= 0 ? <span className="crewc-step" aria-hidden="true">{step + 1}</span> : null}
                  </span>
                  <span className="crewc-box-agent">{model ? `${agentName(role.agent_type)} · ${model}` : agentName(role.agent_type)}</span>
                  <span className="crewc-box-rights">{rights.map((r) => t(`crewcanvas.right.${r}` as never)).join(' · ')}</span>
                  <span className="crewc-box-foot">
                    {(role.standbys ?? 0) > 0 ? <span>{t('crewcanvas.box.ready', { count: role.standbys ?? 0 })}</span> : null}
                    {own.length ? <span className="crewc-bad">{t('crewcanvas.box.problem')}</span> : null}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
