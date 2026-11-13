// The undo bar at the bottom of the cockpit (lib/undo-bar.ts): "Closed Billing tests · Undo". It stays 8 seconds,
// waits while the pointer or focus is on it, and Ctrl+Z is Undo while it shows (not while a text box has focus,
// where Ctrl+Z undoes typing). It tells screen readers politely and never takes focus.
import { useEffect } from 'react';
import { useT } from '../../i18n';
import { holdUndo, runUndo, useUndoBar } from '../../lib/undo-bar';
import '../../styles/cockpit-undo-bar.css';

export function UndoBar() {
  const t = useT();
  const item = useUndoBar();
  const id = item?.id;
  const canUndo = !!item?.undo;

  useEffect(() => {
    if (!canUndo) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'z') return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (target?.closest('input:not([type="checkbox"]):not([type="radio"]), textarea, select, [contenteditable="true"], .terminal-host, .pm-canvas-terminal')) return;
      e.preventDefault();
      runUndo(id);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [canUndo, id]);

  if (!item) return null;
  return (
    <div
      className="ck-undobar"
      role="status"
      aria-live="polite"
      data-testid="undo-bar"
      onMouseEnter={() => holdUndo(true)}
      onMouseLeave={() => holdUndo(false)}
      onFocus={() => holdUndo(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) holdUndo(false);
      }}
    >
      <span className="ck-undobar-text">{item.text}</span>
      {item.undo && (
        <button type="button" className="ck-undobar-btn" onClick={() => runUndo(item.id)} title={t('undo.keyHint')}>
          {t('common.undo')}
        </button>
      )}
    </div>
  );
}
