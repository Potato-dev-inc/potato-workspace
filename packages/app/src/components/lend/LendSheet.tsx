import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import { useSheetKeys } from '../cockpit/Sheet';
import '../../styles/lend.css';

/**
 * A modal sheet for Share an agent. It works in the cockpit and in the Settings window (their tokens are the same),
 * so it goes to whichever of the two is around: inside a card it would be cut off by the card's edges.
 * `size="wide"` is the 560 px sheet of the lend profile steps (full width on a phone); `head` sits at the right of the title.
 */
export function LendSheet({
  title,
  labelledBy,
  onClose,
  children,
  size,
  head,
}: {
  title: string;
  labelledBy: string;
  onClose?: () => void;
  children: ReactNode;
  size?: 'wide';
  head?: ReactNode;
}) {
  const ref = useSheetKeys(onClose);
  const host = typeof document === 'undefined' ? null : (document.querySelector('.settings') ?? document.querySelector('.cockpit'));
  const sheet = (
    <div
      className="lend-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <div ref={ref} className="lend-sheet" data-size={size} role="dialog" aria-modal="true" aria-labelledby={labelledBy}>
        {head ? (
          <div className="lend-sheet-head">
            <h2 id={labelledBy}>{title}</h2>
            {head}
          </div>
        ) : (
          <h2 id={labelledBy}>{title}</h2>
        )}
        {children}
      </div>
    </div>
  );
  return host ? createPortal(sheet, host) : sheet;
}
