// The ? button at the bottom of the sidebar: What's new (with the version pill until seen), Feature guide, Keyboard shortcuts.
import { useRef, useState } from 'react';
import { useT } from '../../i18n';
import { FloatingMenu } from '../cockpit/FloatingMenu';
import { hasTour } from '../../whatsnew/catalog';
import { isSeen, openTour, requestGuide, requestShortcuts, useWhatsNewState, whatsNewVersion } from '../../whatsnew/store';
import '../../styles/whatsnew.css';

const HelpIcon = () => (
  <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="8" cy="8" r="6" />
    <path d="M6.2 6.3a1.9 1.9 0 0 1 3.6.7c0 1.2-1.8 1.4-1.8 2.6M8 11.6v.1" />
  </svg>
);

export function HelpMenu() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  useWhatsNewState(); // redraws the pill when the seen mark changes
  const version = whatsNewVersion();
  const unseen = hasTour(version) && !isSeen(version);
  const pick = (run: () => void) => () => {
    setOpen(false);
    run();
  };
  return (
    <div className="ck-menu-wrap">
      <button type="button" ref={btn} className="ck-icon-btn" aria-label={t('whatsnew.help')} title={t('whatsnew.help')} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <HelpIcon />
      </button>
      {open && (
        <FloatingMenu
          anchorRef={btn}
          prefer="up"
          align="start"
          label={t('whatsnew.help')}
          onClose={(back) => {
            setOpen(false);
            if (back) btn.current?.focus();
          }}
        >
          <button type="button" role="menuitem" className="ck-menu-item wn-help-item" onClick={pick(() => openTour())}>
            {t('whatsnew.menuWhatsNew')}
            {unseen && <span className="wn-newtag">{version}</span>}
          </button>
          <button type="button" role="menuitem" className="ck-menu-item wn-help-item" onClick={pick(requestGuide)}>
            {t('whatsnew.menuGuide')}
          </button>
          <button type="button" role="menuitem" className="ck-menu-item wn-help-item" onClick={pick(requestShortcuts)}>
            {t('whatsnew.menuShortcuts')}
          </button>
        </FloatingMenu>
      )}
    </div>
  );
}
