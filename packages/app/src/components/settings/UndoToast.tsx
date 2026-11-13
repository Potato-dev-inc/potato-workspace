// The small toast at the bottom of the settings column: "Saved. Theme: Light" with Undo.
// It stays 5 seconds and waits while the pointer or focus is on it. Ctrl+Z is Undo while it shows and no text
// field has focus. One toast at a time: a new one replaces the old (the earlier change is then final).
import { useEffect, useRef, useState } from 'react';

export const TOAST_MS = 5000;
export const PUT_BACK_MS = 2000;

export interface ToastState {
  /** A new number for every toast, so a replacement restarts the timer. */
  id: number;
  text: string;
  /** Puts the values back. Absent: no Undo button (the "Put back." note). */
  undo?: () => Promise<void>;
  /** Overrides the 5 seconds. */
  ms?: number;
}

export function UndoToast({ toast, onDone, onUndo }: { toast: ToastState; onDone: (id: number) => void; onUndo: (toast: ToastState) => void }) {
  const [held, setHeld] = useState(false);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    if (held) return;
    const timer = setTimeout(() => doneRef.current(toast.id), toast.ms ?? TOAST_MS);
    return () => clearTimeout(timer);
  }, [held, toast.id, toast.ms]);

  const undoRef = useRef(onUndo);
  undoRef.current = onUndo;
  useEffect(() => {
    if (!toast.undo) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'z') return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (target?.closest('input:not([type="checkbox"]):not([type="radio"]), textarea, select, [contenteditable="true"]')) return;
      e.preventDefault();
      undoRef.current(toast);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [toast]);

  const hold = (on: boolean) => setHeld(on);

  return (
    <div
      className="st-toast"
      role="status"
      aria-live="polite"
      onMouseEnter={() => hold(true)}
      onMouseLeave={() => hold(false)}
      onFocus={() => hold(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) hold(false);
      }}
    >
      <span className="st-toast-text">{toast.text}</span>
      {toast.undo && (
        <button type="button" className="st-toast-undo" onClick={() => onUndo(toast)}>
          Undo
        </button>
      )}
    </div>
  );
}
