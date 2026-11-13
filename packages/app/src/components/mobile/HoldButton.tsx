// A button that needs a press and hold of one second (for the answer that cannot be taken back: allowing something risky).
// Pointer: hold it, a bar fills, let go early and nothing happens. Keyboard: hold Space or Enter. A screen reader double tap has no
// hold: the first activation changes the label to "Press again to confirm" for 3 seconds, and the second one counts.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useT } from '../../i18n';

/** How long the press must last. */
export const HOLD_MS = 1000;
/** After a screen reader first activation, the second one counts for this long. */
export const CONFIRM_MS = 3000;

export function HoldButton({
  label,
  disabled,
  onDone,
  className,
  dataChoice,
}: {
  label: string;
  disabled?: boolean;
  onDone: () => void;
  className?: string;
  dataChoice?: string;
}) {
  const t = useT();
  const [holding, setHolding] = useState(false);
  const [armed, setArmed] = useState(false);
  const timer = useRef(0);
  const armTimer = useRef(0);
  /** A pointer or key press is in progress: the click it ends with is not an assistive activation. */
  const gesture = useRef(false);

  const cancel = () => {
    window.clearTimeout(timer.current);
    setHolding(false);
  };
  const start = () => {
    if (disabled) return;
    gesture.current = true;
    setHolding(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      setHolding(false);
      onDone();
    }, HOLD_MS);
  };
  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
      window.clearTimeout(armTimer.current);
    },
    [],
  );

  const onKeyDown = (event: KeyboardEvent) => {
    if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) {
      event.preventDefault();
      start();
    }
  };
  const onKeyUp = (event: KeyboardEvent) => {
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      cancel();
      gesture.current = false;
    }
  };

  return (
    <button
      type="button"
      className={`${className ?? ''} ph-hold`}
      data-choice={dataChoice}
      data-holding={holding || undefined}
      disabled={disabled}
      aria-description={t('phone.hold.hint')}
      onPointerDown={start}
      onPointerUp={() => {
        cancel();
        window.setTimeout(() => {
          gesture.current = false;
        }, 0);
      }}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onContextMenu={(event) => event.preventDefault()}
      onClick={() => {
        if (gesture.current) return;
        // An assistive activation: ask once more.
        if (armed) {
          window.clearTimeout(armTimer.current);
          setArmed(false);
          onDone();
          return;
        }
        setArmed(true);
        window.clearTimeout(armTimer.current);
        armTimer.current = window.setTimeout(() => setArmed(false), CONFIRM_MS);
      }}
    >
      <span className="ph-hold-fill" aria-hidden="true" />
      <span className="ph-hold-label">{armed ? t('phone.hold.again') : holding ? t('phone.hold.keep') : label}</span>
    </button>
  );
}
