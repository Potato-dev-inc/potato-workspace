// The clear layer laid over the page area: the marks (each with a number badge), the stroke being drawn, the text note
// box, and the one outline that follows the mouse for the Select tool. It is the app's own element, above the frame, so the
// page cannot see it, block it or draw on it. A draw tool makes the layer take the mouse (the page gets no click).
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { useT } from '../../i18n';
import {
  anchorOf,
  constrain,
  isTiny,
  layerTakesMouse,
  MARKUP_SPEC,
  reducedMotion,
  type Hover,
  type Mark,
  type MarkType,
  type MarkupState,
  type Pt,
} from '../../lib/markup/model';

const HALO = 'rgba(255,255,255,.9)';

/** One mark: a white halo under the colour, so it reads on any page. */
function Shape({ m }: { m: Mark }): ReactNode {
  const sw = MARKUP_SPEC.sizes.stroke;
  const common = { fill: 'none', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  const layers = (geo: (p: Record<string, unknown>) => ReactNode) => (
    <>
      {geo({ ...common, stroke: HALO, strokeWidth: sw + MARKUP_SPEC.sizes.halo })}
      {geo({ ...common, stroke: m.color, strokeWidth: sw, strokeDasharray: m.type === 'pick' ? '6 4' : undefined })}
    </>
  );
  const x = Math.min(m.x1, m.x2);
  const y = Math.min(m.y1, m.y2);
  const w = Math.abs(m.x2 - m.x1);
  const h = Math.abs(m.y2 - m.y1);
  if (m.type === 'pen') {
    const d = `M${(m.pts ?? []).map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' L')}`;
    return layers((p) => <path d={d} {...p} />);
  }
  if (m.type === 'rect' || m.type === 'pick') return layers((p) => <rect x={x} y={y} width={w} height={h} rx={4} {...p} />);
  if (m.type === 'ellipse') return layers((p) => <ellipse cx={(m.x1 + m.x2) / 2} cy={(m.y1 + m.y2) / 2} rx={w / 2} ry={h / 2} {...p} />);
  if (m.type === 'arrow') {
    const a = Math.atan2(m.y2 - m.y1, m.x2 - m.x1);
    const L = 12;
    const d = `M${m.x1} ${m.y1} L${m.x2} ${m.y2} M${m.x2 - L * Math.cos(a - 0.45)} ${m.y2 - L * Math.sin(a - 0.45)} L${m.x2} ${m.y2} L${m.x2 - L * Math.cos(a + 0.45)} ${m.y2 - L * Math.sin(a + 0.45)}`;
    return layers((p) => <path d={d} {...p} />);
  }
  const text = m.text ?? '';
  const boxW = text.length * 7.1 + 14;
  return (
    <>
      <rect x={m.x1} y={m.y1 - 15} width={boxW} height={22} rx={5} fill="#fff" stroke={m.color} strokeWidth={2} />
      <text x={m.x1 + 7} y={m.y1} fontSize={13} fontFamily="Segoe UI, system-ui, sans-serif" fill="#111">
        {text}
      </text>
    </>
  );
}

function Badge({ m, n }: { m: Mark; n: number }) {
  const p = anchorOf(m);
  return (
    <g data-testid="markup-badge">
      <circle cx={p.x} cy={p.y} r={MARKUP_SPEC.sizes.badge} fill={m.color} stroke="#fff" strokeWidth={1.5} />
      <text x={p.x} y={p.y + 4} textAnchor="middle" fontSize={11} fontWeight={700} fontFamily="Segoe UI, system-ui, sans-serif" fill="#fff">
        {n}
      </text>
    </g>
  );
}

/**
 * The one outline of the Select tool. The element is created once and only moved: its position and size ease from the
 * last element to the next with a quick springy curve (a little overshoot), the label follows it, and the first time it
 * grows out of the mouse point. With less motion it jumps. It is never created again per hover.
 */
export function Blob({ hover }: { hover: Hover | null }) {
  const box = useRef<HTMLDivElement>(null);
  const label = useRef<HTMLElement>(null);
  const shown = useRef(false);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const place = (x: number, y: number, w: number, h: number) => {
      el.style.transform = `translate(${x}px, ${y}px)`;
      el.style.width = `${w}px`;
      el.style.height = `${h}px`;
    };
    if (!hover) {
      shown.current = false;
      el.style.opacity = '0';
      return;
    }
    if (label.current) label.current.textContent = hover.label;
    const calm = reducedMotion();
    const ease = `${MARKUP_SPEC.blob.ms}ms ${MARKUP_SPEC.blob.curve}`;
    if (calm) {
      el.style.transition = 'none';
      el.dataset.motion = 'off';
      place(hover.x, hover.y, hover.w, hover.h);
      el.style.opacity = '1';
      shown.current = true;
      return;
    }
    el.dataset.motion = 'spring';
    if (!shown.current) {
      // First time: start as a dot under the mouse, then grow into the element.
      el.style.transition = 'none';
      place(hover.cx, hover.cy, 0, 0);
      el.style.opacity = '0';
      void el.offsetWidth;
      shown.current = true;
    }
    el.style.transition = `transform ${ease}, width ${ease}, height ${ease}, opacity 90ms linear`;
    place(hover.x, hover.y, hover.w, hover.h);
    el.style.opacity = '1';
  }, [hover]);
  return (
    <div ref={box} className="mk-blob" aria-hidden="true" data-testid="markup-blob" style={{ opacity: 0 }}>
      <i ref={label} />
    </div>
  );
}

export interface LayerProps {
  state: MarkupState;
  hover: Hover | null;
  /** The picture is being taken: nothing but the page and the marks is drawn. */
  shooting: boolean;
  onDraft: (draft: Mark | null) => void;
  onCommit: (mark: Omit<Mark, 'id'>) => void;
}

export function MarkupLayer({ state, hover, shooting, onDraft, onCommit }: LayerProps) {
  const t = useT();
  const svg = useRef<SVGSVGElement>(null);
  const live = useRef<Mark | null>(null);
  const [note, setNote] = useState<{ x: number; y: number; value: string } | null>(null);
  const noteBox = useRef<HTMLInputElement>(null);
  const takes = layerTakesMouse(state);
  const word = (type: MarkType) => t(`markup.word.${type}` as 'markup.word.pick');

  useEffect(() => {
    if (note) noteBox.current?.focus();
  }, [note]);
  // A new tool ends a note in progress (kept when it has words).
  useEffect(() => {
    if (state.tool !== 'text' || !state.open) commitNote();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.tool, state.open]);

  const pos = (e: ReactPointerEvent): Pt => {
    const r = svg.current?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  };
  function commitNote() {
    setNote((n) => {
      const v = n?.value.trim() ?? '';
      if (n && v) onCommit({ type: 'text', color: state.color, x1: n.x, y1: n.y, x2: n.x, y2: n.y, text: v.slice(0, MARKUP_SPEC.sizes.noteMax) });
      return null;
    });
  }
  const down = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0 || !takes) return;
    const p = pos(e);
    if (state.tool === 'text') {
      e.preventDefault();
      commitNote();
      setNote({ x: p.x, y: p.y, value: '' });
      return;
    }
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      // Not every browser lets a synthetic pointer be captured.
    }
    live.current =
      state.tool === 'pen'
        ? { id: 0, type: 'pen', color: state.color, x1: p.x, y1: p.y, x2: p.x, y2: p.y, pts: [p] }
        : { id: 0, type: state.shape, color: state.color, x1: p.x, y1: p.y, x2: p.x, y2: p.y };
    onDraft(live.current);
  };
  const move = (e: ReactPointerEvent<SVGSVGElement>) => {
    const m = live.current;
    if (!m) return;
    const p = pos(e);
    if (m.type === 'pen') {
      const last = m.pts?.[m.pts.length - 1] ?? p;
      if (Math.abs(p.x - last.x) + Math.abs(p.y - last.y) > 2) live.current = { ...m, pts: [...(m.pts ?? []), p], x2: p.x, y2: p.y };
    } else {
      const c = constrain(m.type, m.x1, m.y1, p.x, p.y, e.shiftKey);
      live.current = { ...m, x2: c.x2, y2: c.y2 };
    }
    onDraft(live.current);
  };
  const up = () => {
    const m = live.current;
    live.current = null;
    if (!m) return;
    if (isTiny(m)) return onDraft(null);
    const { id: _id, ...rest } = m;
    void _id;
    onCommit(rest);
  };

  return (
    <div className={`mk-layer${shooting ? ' is-shooting' : ''}`} data-testid="markup-layer" data-tool={state.tool}>
      <svg
        ref={svg}
        className={`mk-ink${takes ? ' is-live' : ''}${state.tool === 'text' ? ' is-text' : ''}`}
        data-testid="markup-ink"
        aria-hidden="true"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={() => {
          live.current = null;
          onDraft(null);
        }}
      >
        {state.marks.map((m, i) => (
          <g key={m.id} className={m.type === 'pick' ? 'mk-pop-in' : undefined}>
            <Shape m={m} />
            <Badge m={m} n={i + 1} />
          </g>
        ))}
        {state.draft && <Shape m={state.draft} />}
      </svg>
      <Blob hover={state.open && state.tool === 'select' ? hover : null} />
      {note && (
        <input
          ref={noteBox}
          className="mk-note"
          style={{ left: note.x, top: note.y - 14, borderColor: state.color }}
          value={note.value}
          maxLength={MARKUP_SPEC.sizes.noteMax}
          placeholder={t('markup.notePlaceholder')}
          aria-label={t('markup.noteLabel')}
          data-testid="markup-note"
          onChange={(e) => setNote({ ...note, value: e.target.value })}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Enter') {
              e.preventDefault();
              commitNote();
            } else if (e.key === 'Escape') {
              e.stopPropagation();
              setNote(null);
            }
          }}
          onBlur={commitNote}
        />
      )}
      {/* A list for screen readers: it backs Undo as well ("Mark 2: arrow pointing at ..."). */}
      <ol className="mk-sr" aria-label={t('markup.marksList')}>
        {state.marks.map((m, i) => (
          <li key={m.id}>{`${i + 1}. ${word(m.type)}${m.type === 'text' ? ` "${m.text ?? ''}"` : m.near ? ` ${m.near.tag}` : ''}`}</li>
        ))}
      </ol>
    </div>
  );
}
