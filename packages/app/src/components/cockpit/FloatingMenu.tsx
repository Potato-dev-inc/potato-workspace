// A pop-up menu in the app's top layer. Now a thin wrapper over the shared layer (components/common/Floating.tsx): it
// draws into the cockpit root, sits under its button (above when there is no room), closes through useDismissable,
// and answers Up/Down/Escape/Tab. `placeFloating` and `FLOAT_EDGE` live there; they are re-exported for old imports.
import type { ReactNode, RefObject } from 'react';
import { Menu } from '../common/Floating';

export { FLOAT_EDGE, placeFloating, type Box, type FloatPlace } from '../common/Floating';

export function FloatingMenu({
  anchorRef,
  onClose,
  align = 'end',
  prefer = 'down',
  className,
  label,
  children,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  /** Called when the menu should close; `returnFocus` is true after Escape. */
  onClose: (returnFocus: boolean) => void;
  align?: 'start' | 'end';
  prefer?: 'down' | 'up';
  className?: string;
  label?: string;
  children: ReactNode;
}) {
  return (
    <Menu anchorRef={anchorRef} onClose={onClose} align={align} prefer={prefer} className={className} label={label}>
      {children}
    </Menu>
  );
}
