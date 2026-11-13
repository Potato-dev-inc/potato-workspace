// The phone's header: three things. The menu button (with how many chats wait), the chat's name with its state (tap it for
// Terminal and Close chat), and a new chat button. Nothing else lives up here.
import { useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n';
import type { PaneView } from '../../lib/mobile-pane-view';
import '../../styles/phone-shell.css';

export function PhoneHeader({
  title,
  stateWords,
  waiting,
  bridgeReady,
  onMenu,
  onNew,
  peek,
  onBack,
}: {
  title: string;
  /** The chat's state in plain words, under the name. */
  stateWords: string | null;
  /** How many chats wait for the person. */
  waiting: number;
  bridgeReady: boolean;
  onMenu: () => void;
  onNew: () => void;
  /** The name opens a small menu when given: the view switch and Close chat. Left out (overview, companion): the name is plain. */
  peek?: { view: PaneView; canSwitch: boolean; onView: (view: PaneView) => void; onClose: () => void };
  /** After a jump from the "needs you" pill: a back arrow to the chat you came from. */
  onBack?: { label: string; go: () => void };
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // The little menu closes on Escape, on a tap outside, and when the chat changes.
  useEffect(() => {
    setOpen(false);
    setConfirm(false);
  }, [title]);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const onDown = (event: PointerEvent) => {
      if (rootRef.current && event.target instanceof Node && !rootRef.current.contains(event.target)) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [open]);

  const name = (
    <>
      <span className="ph-head-name">{title}</span>
      {stateWords && <span className="ph-head-state">{stateWords}</span>}
    </>
  );

  return (
    <header className="ph-head">
      {onBack && (
        <button type="button" className="ph-iconbtn ph-back" data-testid="phone-back" aria-label={t('phone.header.back', { name: onBack.label })} onClick={onBack.go}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m15 5-7 7 7 7" />
          </svg>
        </button>
      )}
      <button
        type="button"
        className="ph-iconbtn ph-head-menu"
        aria-label={waiting > 0 ? t('phone.menuWaiting', { count: waiting }) : t('phone.menuOpen')}
        onClick={onMenu}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 7h16M4 12h10M4 17h16" />
        </svg>
        {waiting > 0 && <span className="ph-badge" aria-hidden="true">{waiting}</span>}
      </button>
      <div className="ph-head-mid" ref={rootRef}>
        {peek ? (
          <button type="button" className="ph-head-title" aria-haspopup="menu" aria-expanded={open} aria-label={`${title}. ${t('phone.header.options')}`} onClick={() => setOpen((v) => !v)}>
            {name}
          </button>
        ) : (
          <div className="ph-head-title ph-head-title--plain">{name}</div>
        )}
        {peek && open && (
          <div className="ph-peek" role="menu" data-testid="phone-peek">
            {!confirm && peek.canSwitch && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  peek.onView(peek.view === 'terminal' ? 'chat' : 'terminal');
                  setOpen(false);
                }}
              >
                {peek.view === 'terminal' ? t('phone.header.showChat') : t('phone.header.showTerminal')}
              </button>
            )}
            {!confirm && (
              <button type="button" role="menuitem" className="ph-peek-danger" onClick={() => setConfirm(true)}>
                {t('phone.header.closeChat')}
              </button>
            )}
            {confirm && (
              <div className="ph-peek-confirm">
                <p>{t('phone.header.closeAsk')}</p>
                <div>
                  <button type="button" onClick={() => setConfirm(false)}>
                    {t('phone.header.keep')}
                  </button>
                  <button
                    type="button"
                    className="ph-peek-danger"
                    onClick={() => {
                      setOpen(false);
                      setConfirm(false);
                      peek.onClose();
                    }}
                  >
                    {t('phone.header.closeYes')}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      <button type="button" className="ph-iconbtn" aria-label={t('phone.newChat')} onClick={onNew} disabled={!bridgeReady}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
    </header>
  );
}
