// The chat's detail level in the header: one small dropdown, "View: Summary ▾", that opens a menu of Summary | Normal |
// Verbose. One pill at every width, so it takes little room and sits on the same row as the model line
// (styles/cockpit-chat.css and styles/phone-chat.css give the phone a 44px touch area).
import { useEffect, useRef, useState } from 'react';
import { FloatingMenu } from '../cockpit/FloatingMenu';
import { useT } from '../../i18n';
import { CHAT_VIEW_MODES, type ChatViewMode } from './chatViewMode';
import { useRegisterAction } from '../../whatsnew/registry';
import { ChatLookSwitches } from './ChatLookSwitches';

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

/** The pill and its menu. The menu is always in the top layer now, so `compact` (a tight pane header) changes nothing. */
export function ViewModeToggle({ mode, onChange }: { mode: ChatViewMode; onChange: (mode: ChatViewMode) => void; compact?: boolean }) {
  return <ViewModeMenu mode={mode} onChange={onChange} />;
}

/** The phone's compact switch: a pill with the current mode, and a small menu of the three modes under it. */
export function ViewModeMenu({ mode, onChange }: { mode: ChatViewMode; onChange: (mode: ChatViewMode) => void }) {
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

  // The shared Menu closes on an outside press, Escape and Tab; the pill gives the focus back after Escape.
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
      {open && (
        <FloatingMenu anchorRef={pill} className="ck-chat-mode-menu" label={menuLabel} onClose={(back) => { setOpen(false); if (back) pill.current?.focus(); }}>
          {CHAT_VIEW_MODES.map((value) => (
            <button key={value} type="button" role="menuitemradio" aria-checked={mode === value} className="ck-menu-item" onClick={() => { onChange(value); setOpen(false); }}>
              {labels[value]}
            </button>
          ))}
          <ChatLookSwitches />
        </FloatingMenu>
      )}
    </div>
  );
}
