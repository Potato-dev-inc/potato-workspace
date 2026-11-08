// A button that only acts when it is held down (mouse, finger, or Space/Enter kept pressed) until it has filled. For
// the "yes" to something that deletes or moves things. Letting go early, leaving, or losing focus starts over.
import { useCallback, useEffect, useRef, type ReactNode } from 'react';

export const HOLD_MS = 800;

export function HoldButton({ onDone, children, label, className, holdMs = HOLD_MS }: { onDone: () => void; children: ReactNode; label: string; className?: string; holdMs?: number }) {
  const ref = useRef<HTMLButtonElement>(null);
  const frame = useRef(0);
  const began = useRef<number | null>(null);
  const done = useRef(onDone);
  done.current = onDone;

  const paint = (p: number) => ref.current?.style.setProperty('--p', String(p));
  const stop = useCallback(() => {
    began.current = null;
    cancelAnimationFrame(frame.current);
    ref.current?.removeAttribute('data-holding');
    paint(0);
  }, []);
  const step = useCallback(
    () => {
      if (began.current === null) return;
      const p = Math.min(1, (performance.now() - began.current) / holdMs);
      paint(p);
      if (p >= 1) {
        stop();
        done.current();
        return;
      }
      frame.current = requestAnimationFrame(step);
    },
    [holdMs, stop],
  );
  const start = useCallback(() => {
    if (began.current !== null) return;
    began.current = performance.now();
    ref.current?.setAttribute('data-holding', '');
    frame.current = requestAnimationFrame(step);
  }, [step]);
  useEffect(() => stop, [stop]);

  return (
    <button
      ref={ref}
      type="button"
      className={className}
      aria-label={label}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          /* not every environment captures */
        }
        start();
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key !== ' ' && e.key !== 'Enter') return;
        e.preventDefault();
        if (!e.repeat) start();
      }}
      onKeyUp={(e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          stop();
        }
      }}
      onBlur={stop}
    >
      {children}
    </button>
  );
}
