// The chat's detail level in the header: one small dropdown, "View: Summary ▾", that opens a menu of Summary | Normal |
// Verbose. One pill at every width, so it takes little room and sits on the same row as the model line
// (styles/cockpit-chat.css and styles/phone-chat.css give the phone a 44px touch area).
import { useEffect, useRef, useState } from 'react';
import { FloatingMenu } from '../cockpit/FloatingMenu';
import { useT } from '../../i18n';
import { CHAT_VIEW_MODES, type ChatViewMode } from './chatViewMode';
import { useDismissable } from '../../hooks/useDismissable';
import { useRegisterAction } from '../../whatsnew/registry';

/** Narrower than this: the header shows the one-pill menu. */
export const COMPACT_VIEW_QUERY = '(max-width: 599px)';

/** True while the window is narrower than COMPACT_VIEW_QUERY. Follows resizes. */
export function useCompactViewMode(): boolean {
  const [compact, setCompact] = useState(() => typeof window !== 'undefined' && window.matchMedia?.(COMPACT_VIEW_QUERY).matches === true);
  useEffect(() => {
    const mq = typeof window !== 'undefined' ? window.matchMedia?.(COMPACT_VIEW_QUERY) : undefined;
    if (!mq) return;
    const onChange = (): void => setCompact(mq.matches);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);
  return compact;
}

/** The names of the three modes, in the person's language. */
export function useViewLabels(): Record<ChatViewMode, string> {
  const t = useT();
  return { summary: t('chatView.summary'), normal: t('chatView.normal'), verbose: t('chatView.verbose') };
}

export function ViewModeToggle({ mode, onChange, compact: tight }: { mode: ChatViewMode; onChange: (mode: ChatViewMode) => void; /** The host is tight (a narrow pane header): draw the menu in the top layer. */ compact?: boolean }) {
  return <ViewModeMenu mode={mode} onChange={onChange} floating={!!tight} />;
}

/** The phone's compact switch: a pill with the current mode, and a small menu of the three modes under it. */
export function ViewModeMenu({ mode, onChange, floating }: { mode: ChatViewMode; onChange: (mode: ChatViewMode) => void; /** Draw the menu in the top layer (a pane header would clip it). */ floating?: boolean }) {
  const t = useT();
  const labels = useViewLabels();
  const menuLabel = t('chatView.menu');
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const pill = useRef<HTMLButtonElement>(null);

  // What's new "Try it": open this menu. The pill that is on screen answers.
  useRegisterAction('chat.viewMenu', () => {
    setOpen(true);
    pill.current?.focus();
  });

  // A tap outside the pill and its menu, or Escape, closes the menu.
  useDismissable(open && !floating, { inside: [wrap], anchor: wrap, onDismiss: () => setOpen(false) });

  return (
    <div ref={wrap} className="relative ml-auto shrink-0 ck-chat-mode-wrap">
      <button
        ref={pill}
        type="button"
        className="ck-chat-mode-pill"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${menuLabel}: ${labels[mode]}`}
        onClick={() => setOpen((v) => !v)}
      >
        {t('chatView.label', { mode: labels[mode] })}
        <span aria-hidden="true"> ▾</span>
      </button>
      {open && floating && (
        <FloatingMenu anchorRef={pill} label={menuLabel} onClose={(back) => { setOpen(false); if (back) pill.current?.focus(); }}>
          {CHAT_VIEW_MODES.map((value) => (
            <button key={value} type="button" role="menuitemradio" aria-checked={mode === value} className="ck-menu-item" onClick={() => { onChange(value); setOpen(false); }}>
              {labels[value]}
            </button>
          ))}
        </FloatingMenu>
      )}
      {open && !floating && (
        <div role="menu" aria-label={menuLabel} className="ck-chat-mode-menu">
          {CHAT_VIEW_MODES.map((value) => (
            <button
              key={value}
              type="button"
              role="menuitemradio"
              aria-checked={mode === value}
              className="ck-chat-mode-item"
              onClick={() => {
                onChange(value);
                setOpen(false);
              }}
            >
              {labels[value]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
