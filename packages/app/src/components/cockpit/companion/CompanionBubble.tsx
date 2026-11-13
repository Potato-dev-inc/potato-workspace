// The small bubble beside the companion row (or beside an agent's row): Potato's face, a few lines, a few buttons.
// Fixed on screen so no sidebar overflow can clip it. It never takes the keyboard on its own; Esc closes it.
import { useEffect, useLayoutEffect, useState, type ReactNode } from 'react';
import type { PotatoState } from '../PotatoFace';
import { PotatoFace } from '../PotatoFace';
import '../../../styles/cockpit-potato-bubble.css';

export interface AnchorBox {
  left: number;
  top: number;
}

const BOX_GAP = 10;

/** The sidebar row of one agent. */
export const rowSelector = (paneId: string): string => `[data-pane-row="${paneId.split('"').join('').split('\\').join('')}"]`;

/** Where the bubble goes: to the right of the element, level with its top; null when the element is not on screen. */
export function anchorBeside(selector: string): AnchorBox | null {
  const el = document.querySelector(selector);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return { left: r.right + BOX_GAP, top: Math.max(8, r.top - 4) };
}

/** The anchor, read again when the window changes size. */
export function useAnchor(selector: string, watch: unknown): AnchorBox | null {
  const [box, setBox] = useState<AnchorBox | null>(null);
  useLayoutEffect(() => {
    const read = () => setBox(anchorBeside(selector));
    read();
    window.addEventListener('resize', read);
    return () => window.removeEventListener('resize', read);
  }, [selector, watch]);
  return box;
}

export interface CompanionBubbleProps {
  face: PotatoState;
  /** Names the bubble for a screen reader ("Potato has something to say"). */
  label: string;
  anchor: AnchorBox | null;
  /** The bubble is closed (Esc). */
  onClose?: () => void;
  children: ReactNode;
  testId?: string;
}

export function CompanionBubble({ face, label, anchor, onClose, children, testId }: CompanionBubbleProps) {
  useEffect(() => {
    if (!onClose) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const style = anchor ? { left: anchor.left, top: anchor.top } : { left: 16, bottom: 56 };
  return (
    <div className={`ck-pbubble${anchor ? '' : ' ck-pbubble--corner'}`} role="status" aria-live="polite" aria-label={label} style={style} data-testid={testId ?? 'companion-bubble'}>
      <span className="ck-pbubble-face">
        <PotatoFace state={face} size={28} />
      </span>
      <div className="ck-pbubble-body">{children}</div>
    </div>
  );
}
