// Root of a pulled-out tab's own window (route `index.html?tabwin=1&pane=..&tab=chat|file:<path>`, label
// `tab-window-*`). It shows the SAME pane through the same backend events as the main window: no second agent starts.
// A slim bar has "Put back" (closing the window does the same). The chat shows the pane's full view; a file shows the file.
import { useEffect, useState } from 'react';
import { applyTheme, loadSettings, type AppTheme } from './lib/settings';
import { subscribeSettingsTheme } from './lib/settings-sync';
import { useCockpit } from './hooks/useCockpit';
import { PaneView, seedRememberedTab } from './components/cockpit/PaneView';
import { FileTab } from './components/files/FileTab';
import { CHAT_TAB, tabWindowsApi, type TabWindowsApi } from './lib/tab-windows';
import { pathOfTab } from './lib/file-tabs';
import { useT } from './i18n';
import './styles/cockpit.css';
import './styles/files.css';

/** What the window shows, from its address: the chat, a file, or nothing it knows. */
export function tabOfWindow(search: string): { paneId: string; chat: boolean; path: string | null } {
  const params = new URLSearchParams(search);
  const tab = params.get('tab') ?? '';
  return { paneId: params.get('pane') ?? '', chat: tab === CHAT_TAB, path: pathOfTab(tab) };
}

export default function TabWindowApp({ api = tabWindowsApi }: { api?: TabWindowsApi }) {
  const t = useT();
  const { paneId, chat, path } = tabOfWindow(window.location.search);
  const tab = chat ? CHAT_TAB : `file:${path ?? ''}`;
  const c = useCockpit();
  const [theme, setTheme] = useState<AppTheme>('dark');
  // The chat window opens on the chat, not on the terminal a plain agent starts on.
  if (chat) seedRememberedTab(paneId, CHAT_TAB);

  useEffect(() => {
    let live = true;
    loadSettings()
      .then((s) => {
        if (!live) return;
        setTheme(s.theme ?? 'dark');
        applyTheme(s.theme ?? 'dark');
      })
      .catch(() => undefined);
    const off = subscribeSettingsTheme((next) => {
      setTheme(next);
      applyTheme(next);
    });
    return () => {
      live = false;
      off();
    };
  }, []);

  const pane = c.registry.panes.get(paneId);
  const name = c.names.get(paneId) ?? pane?.info.agent_type ?? '';
  const label = chat ? name : (path ?? '').slice((path ?? '').lastIndexOf('/') + 1);
  const gone = c.registry.initialReady && !pane;
  return (
    <div className="cockpit ck-tabwin" data-theme={theme} data-testid="tab-window">
      <div className="ck-tabwin-bar" role="toolbar" aria-label={t('tabwin.barLabel')}>
        <span className="ck-tabwin-name">{label}</span>
        <button type="button" className="ck-btn ck-btn--secondary ck-btn--sm" title={t('tabwin.putBackTip')} data-testid="tab-put-back" onClick={() => void api.putBack(paneId, tab).catch(() => undefined)}>
          {t('tabwin.putBack')}
        </button>
      </div>
      <div className="ck-tabwin-body">
        {!paneId || (!chat && !path) ? null : gone ? (
          <p className="ck-sub ck-pad">{t('tabwin.gone')}</p>
        ) : pane ? (
          chat ? (
            <PaneView c={c} paneId={paneId} inWindow />
          ) : (
            <FileTab paneId={paneId} path={path ?? ''} canTell={false} refreshKey={pane.status} />
          )
        ) : null}
      </div>
    </div>
  );
}
