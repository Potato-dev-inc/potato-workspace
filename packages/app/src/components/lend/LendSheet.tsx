import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import { useSheetKeys } from '../cockpit/Sheet';
import '../../styles/lend.css';

/**
 * A modal sheet for Share an agent. It works in the cockpit and in the Settings window (their tokens are the same),
 * so it goes to whichever of the two is around: inside a card it would be cut off by the card's edges.
 */
export function LendSheet({ title, labelledBy, onClose, children }: { title: string; labelledBy: string; onClose?: () => void; children: ReactNode }) {
  const ref = useSheetKeys(onClose);
  const host = typeof document === 'undefined' ? null : (document.querySelector('.settings') ?? document.querySelector('.cockpit'));
  const sheet = (
    <div
      className="lend-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <div ref={ref} className="lend-sheet" role="dialog" aria-modal="true" aria-labelledby={labelledBy}>
        <h2 id={labelledBy}>{title}</h2>
        {children}
      </div>
    </div>
  );
  return host ? createPortal(sheet, host) : sheet;
}
