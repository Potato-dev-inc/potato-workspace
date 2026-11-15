// "Open in" for a page: beside the chat (the default, a locked frame), its own window, or the agent browser (a real tab the
// agent can read and click). The page stays as locked in the browser as it is beside the chat; the PC serves it only to
// that tab (see `artifacts/serve.rs`).
import { useRef, useState } from 'react';
import { useDismissable } from '../../hooks/useDismissable';
import { useT } from '../../i18n';

export function OpenInMenu({ beside, onWindow, onBrowser }: { beside: boolean; onWindow?: () => void; onBrowser: () => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useDismissable(open, { inside: [box], onDismiss: () => setOpen(false) });
  const pick = (go?: () => void) => {
    setOpen(false);
    go?.();
  };
  return (
    <span className="ck-openin" ref={box}>
      <button type="button" className="ck-btn ck-btn--plain ck-btn--sm" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)} data-testid="artifact-openin">
        {t('markup.openIn')} {'▾'}
      </button>
      {open && (
        <div className="ck-openin-menu" role="menu" data-testid="artifact-openin-menu">
          <button type="button" role="menuitemradio" aria-checked={beside} onClick={() => pick()} data-testid="openin-beside">
            <span className="ck-openin-ck">{beside ? '✓' : ''}</span>
            <span>
              {t('markup.openIn.beside')}
              <small>{t('markup.openIn.besideHint')}</small>
            </span>
          </button>
          <button type="button" role="menuitemradio" aria-checked={!beside} onClick={() => pick(onWindow)} data-testid="openin-window">
            <span className="ck-openin-ck">{!beside ? '✓' : ''}</span>
            <span>
              {t('markup.openIn.window')}
              <small>{t('markup.openIn.windowHint')}</small>
            </span>
          </button>
          <button type="button" role="menuitemradio" aria-checked="false" onClick={() => pick(onBrowser)} data-testid="openin-browser">
            <span className="ck-openin-ck" />
            <span>
              {t('markup.openIn.browser')}
              <small>{t('markup.openIn.browserHint')}</small>
            </span>
          </button>
        </div>
      )}
    </span>
  );
}
