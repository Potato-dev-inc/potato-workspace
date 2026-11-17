// The agent browser's place in the dock (Labs "Browser in the side panel"). Top to bottom: the tabs, the bar (back, forward,
// reload, the address, Mark up, Pop out) and the page area. The bars are app content; only the page area is the native child
// webview, which Rust puts over this element's rectangle (`lib/dock-browser`). The pane reports that rectangle, and it
// reports null the moment it is hidden (it unmounts when the column or the pane is folded, or the pane is closed).
// While a menu, a sheet or a drag is over the page, the page area shows a picture of the page instead (`useBrowserFreeze`).
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useT } from '../../../i18n';
import {
  currentBrowserRect,
  dockBack,
  dockClose,
  dockMarkUp,
  dockNav,
  dockNewTab,
  dockOpenOutside,
  isWebAddress,
  dockPopOut,
  dockSelect,
  dockTabs,
  onDockTabs,
  reportBrowserRect,
  type DockTab,
} from '../../../lib/dock-browser';
import { useMarkupEnabled } from '../../../lib/markup/labs';
import { useBrowserFreeze } from './useBrowserFreeze';

const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d={d} />
  </svg>
);

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

export function BrowserPane({ paneId }: { paneId: string }) {
  const t = useT();
  const page = useRef<HTMLDivElement>(null);
  const markUp = useMarkupEnabled();
  const [tabs, setTabs] = useState<DockTab[] | null>(null);
  const [address, setAddress] = useState('');
  const editing = useRef(false);

  useEffect(() => {
    const el = page.current;
    if (!el) return undefined;
    // The rectangle can move without resizing (the sidebar folds, a splitter above moves), so it is checked every frame
    // while the pane is shown. Repeats are dropped by `reportBrowserRect`.
    let raf = 0;
    const tick = () => {
      const r = el.getBoundingClientRect();
      reportBrowserRect(paneId, { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) });
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      cancelAnimationFrame(raf);
      reportBrowserRect(paneId, null);
    };
  }, [paneId]);

  const rect = useCallback(() => currentBrowserRect(paneId), [paneId]);
  const { picture, still } = useBrowserFreeze(page, rect, true);

  useEffect(() => {
    let alive = true;
    void dockTabs().then((list) => alive && setTabs((old) => old ?? list));
    const stop = onDockTabs((list) => alive && setTabs(list));
    return () => {
      alive = false;
      stop();
    };
  }, []);

  // The pane never shows an empty page: with no tab it opens one on the start page (after a moment, in case an agent is
  // opening its page right now and would otherwise find two).
  const none = tabs !== null && tabs.length === 0;
  useEffect(() => {
    if (!none) return undefined;
    const open = () =>
      void dockTabs().then((list) => {
        if (list.length === 0) void dockNewTab(true);
      });
    const first = window.setTimeout(open, 500);
    const again = window.setInterval(open, 3000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(again);
    };
  }, [none]);

  const active = tabs?.find((x) => x.active) ?? tabs?.[0] ?? null;
  const popped = !!active?.popped;
  useEffect(() => {
    if (!editing.current) setAddress(active?.url ?? '');
  }, [active?.id, active?.url]);

  const go = (e: FormEvent) => {
    e.preventDefault();
    const typed = address.trim();
    if (typed) void dockNav('go', typed);
  };
  const nameOf = (tab: DockTab) => tab.title || (tab.url ? hostOf(tab.url) : t('dock.newTabName'));

  return (
    <div className="tk-view tk-browser" data-testid="dock-browser">
      <div className="bp-tabs" role="tablist" aria-label={t('dock.browserTabs')}>
        {(tabs ?? []).map((tab) => (
          <div key={tab.id} className="bp-tab" data-active={tab.id === active?.id ? 'true' : undefined} data-testid="dock-tab">
            <button type="button" role="tab" aria-selected={tab.id === active?.id} className="bp-tab-main" onClick={() => void dockSelect(tab.id)} title={tab.url || nameOf(tab)}>
              {nameOf(tab)}
            </button>
            <button type="button" className="bp-tab-x" onClick={() => void dockClose(tab.id)} aria-label={t('dock.closeTab', { name: nameOf(tab) })} title={t('dock.closeTab', { name: nameOf(tab) })}>
              <Icon d="m4.5 4.5 7 7M11.5 4.5l-7 7" />
            </button>
          </div>
        ))}
        <button type="button" className="tk-btn tk-icon" data-testid="dock-new-tab" onClick={() => void dockNewTab()} aria-label={t('dock.newTab')} title={t('dock.newTab')}>
          <Icon d="M8 3.5v9M3.5 8h9" />
        </button>
      </div>
      <form className="bp-bar" onSubmit={go}>
        <button type="button" className="tk-btn tk-icon" disabled={!active || popped} onClick={() => void dockNav('back')} aria-label={t('dock.back')} title={t('dock.back')}>
          <Icon d="M10 3 5 8l5 5" />
        </button>
        <button type="button" className="tk-btn tk-icon" disabled={!active || popped} onClick={() => void dockNav('forward')} aria-label={t('dock.forward')} title={t('dock.forward')}>
          <Icon d="m6 3 5 5-5 5" />
        </button>
        <button type="button" className="tk-btn tk-icon" disabled={!active || popped} onClick={() => void dockNav('reload')} aria-label={t('dock.reload')} title={t('dock.reload')}>
          <Icon d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3h-3" />
        </button>
        <input
          className="bp-address"
          value={address}
          disabled={!active || popped}
          placeholder={t('dock.addressPlaceholder')}
          aria-label={t('dock.address')}
          spellCheck={false}
          onChange={(e) => setAddress(e.target.value)}
          onFocus={(e) => {
            editing.current = true;
            e.currentTarget.select();
          }}
          onBlur={() => {
            editing.current = false;
            setAddress(active?.url ?? '');
          }}
        />
        {markUp && (
          <button type="button" className="tk-btn bp-text" disabled={!active || popped} onClick={() => void dockMarkUp()} data-testid="dock-mark-up">
            {t('dock.markUp')}
          </button>
        )}
        <button type="button" className="tk-btn tk-icon" disabled={!active || popped} onClick={() => active && void dockPopOut(active.id)} aria-label={t('dock.popOut')} title={t('dock.popOut')} data-testid="dock-pop-out">
          <Icon d="M9.5 3H13v3.5M13 3 8 8M11 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h2.5" />
        </button>
        <button type="button" className="tk-btn tk-icon" disabled={!active || !isWebAddress(active.url)} onClick={() => active && void dockOpenOutside(active.url)} aria-label={t('dock.openOutside')} title={t('dock.openOutside')} data-testid="dock-open-outside">
          <Icon d="M7 3H4a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V9M9 3h4v4M13 3 7.5 8.5" />
        </button>
      </form>
      {active?.error && (
        <p className="bp-error" role="alert">
          {t(`dock.err.${active.error}` as never)}
        </p>
      )}
      <div ref={page} className="tk-page-area bp-page" data-testid="dock-browser-page" data-frozen={still ? 'true' : undefined}>
        {popped ? (
          <div className="bp-note" data-testid="dock-popped">
            <p className="tk-quiet">{t('dock.popped')}</p>
            <button type="button" className="tk-btn bp-text" onClick={() => active && void dockBack(active.id)} data-testid="dock-bring-back">
              {t('dock.bringBack')}
            </button>
          </div>
        ) : picture ? (
          <img className="bp-still" src={picture} alt="" data-testid="dock-still" />
        ) : still ? (
          <p className="tk-quiet" data-testid="dock-still">
            {active ? nameOf(active) : ''}
          </p>
        ) : none ? (
          <p className="tk-quiet">{t('dock.browserSoon')}</p>
        ) : null}
      </div>
    </div>
  );
}
