import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type WheelEvent } from 'react';
import type { PaneInfo } from '../../lib/tauri-types';
import '../../styles/individual-mode.css';

export interface MiniBarProps {
  panes: PaneInfo[];
  /** The Undo toast is up. */
  toast: boolean;
  onFocusPane: (id: string) => void;
  /** Close one agent: its pane and, by the app's setting, the helpers it started. */
  onClosePane?: (id: string) => void;
  /** The width (logical px) the bar wants so every chip fits; the window grows up to the screen, then the strip scrolls. */
  onWantWidth?: (px: number) => void;
  onNew: () => void;
  onBack: () => void;
  onUndo: () => void;
}

/** Last folder name of a path, either slash style. */
export function projectName(cwd: string): string {
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

function agentName(id: string): string {
  return id ? id.charAt(0).toUpperCase() + id.slice(1).replace(/_/g, ' ') : 'Agent';
}

/** The strip that stays on screen in Individual mode: a chip per agent, New, Back, and the 8 s Undo. */
export function MiniBar({ panes, toast, onFocusPane, onClosePane, onWantWidth, onNew, onBack, onUndo }: MiniBarProps) {
  const barRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState({ start: false, end: false });

  const measure = useCallback(() => {
    const el = stripRef.current;
    if (!el) return;
    const start = el.scrollLeft > 1;
    const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setFade((f) => (f.start === start && f.end === end ? f : { start, end }));
  }, []);

  // Ask the window for the width every chip needs; New and Back keep their share, the strip takes the rest.
  useLayoutEffect(() => {
    const bar = barRef.current;
    const strip = stripRef.current;
    if (strip && bar && onWantWidth && strip.scrollWidth > 0) onWantWidth(bar.clientWidth - strip.clientWidth + strip.scrollWidth);
    measure();
  }, [panes, toast, onWantWidth, measure]);

  useEffect(() => {
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [measure]);

  // Most mice only turn the wheel vertically: send it sideways along the strip.
  const onWheel = (e: WheelEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollWidth <= el.clientWidth) return;
    const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (dx === 0) return;
    el.scrollLeft += dx;
    measure();
  };

  // Delete or Backspace on a focused chip closes it too (the x is the visible way).
  const onChipKey = (e: KeyboardEvent<HTMLElement>, id: string) => {
    const onChip = (e.target as HTMLElement).classList.contains('mb-chip');
    if ((e.key === 'Delete' || e.key === 'Backspace') && onClosePane && onChip) {
      e.preventDefault();
      onClosePane(id);
    }
  };

  return (
    <div className="mb" role="toolbar" aria-label="Individual mode" ref={barRef}>
      {toast ? (
        <div className="mb-toast" role="status">
          <span>Each agent now has its own window.</span>
          <button type="button" className="mb-link" onClick={onUndo}>
            Undo
          </button>
        </div>
      ) : panes.length === 0 ? (
        <>
          <span className="mb-empty">No agents yet</span>
          <button type="button" className="mb-btn" onClick={onNew}>
            Start one
          </button>
        </>
      ) : (
        <>
          <div className={`mb-chips-wrap${fade.start ? ' mb-fade-start' : ''}${fade.end ? ' mb-fade-end' : ''}`}>
            <div className="mb-chips" ref={stripRef} onWheel={onWheel} onScroll={measure}>
              {panes.map((p) => {
                const proj = projectName(p.cwd);
                const name = agentName(p.agent_type);
                return (
                  <span key={p.id} className="mb-chip-slot" onKeyDown={(e) => onChipKey(e, p.id)}>
                    <button
                      type="button"
                      className="mb-chip"
                      title={`${name}: ${p.status.replace('_', ' ')}${p.lane === 'acp' ? ' · Chat' : ''}`}
                      onClick={() => onFocusPane(p.id)}
                    >
                      <span className={`mb-dot mb-dot--${p.status}`} aria-hidden="true" />
                      <span className="mb-chip-name">{name}</span>
                      {proj && <span className="mb-chip-proj">{proj}</span>}
                    </button>
                    {onClosePane && (
                      <button
                        type="button"
                        className="mb-chip-x"
                        aria-label={`Close ${name}${proj ? ` ${proj}` : ''}`}
                        title="Close this agent"
                        onClick={(e) => {
                          e.stopPropagation();
                          onClosePane(p.id);
                        }}
                      >
                        ×
                      </button>
                    )}
                  </span>
                );
              })}
            </div>
          </div>
          <button type="button" className="mb-btn" onClick={onNew}>
            + New
          </button>
        </>
      )}
      <button type="button" className="mb-btn" onClick={onBack}>
        Back to Orchestration
      </button>
    </div>
  );
}
