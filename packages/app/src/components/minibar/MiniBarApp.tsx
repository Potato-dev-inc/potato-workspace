import { useCallback, useEffect, useRef, useState } from 'react';
import { cockpitApi } from '../../lib/cockpit-api';
import { tauri } from '../../lib/tauri';
import type { PaneInfo } from '../../lib/tauri-types';
import { MiniBar, agentName } from './MiniBar';
import { useAgentRegistry } from '../../lib/agentRegistry';

/** The mini bar window (`index.html?minibar=1`): live agents from the pane list, and the mode buttons. */
export default function MiniBarApp() {
  const [panes, setPanes] = useState<PaneInfo[]>([]);
  const [toast, setToast] = useState(false);
  const listing = useAgentRegistry();
  const timer = useRef<number | undefined>(undefined);

  const showToast = useCallback((ms: number) => {
    window.clearTimeout(timer.current);
    if (ms <= 0) {
      setToast(false);
      return;
    }
    setToast(true);
    timer.current = window.setTimeout(() => setToast(false), ms);
  }, []);

  useEffect(() => {
    document.documentElement.classList.add('mb-root');
    let disposed = false;
    const offs: Array<() => void> = [];
    const refresh = () =>
      void tauri
        .listPanes()
        .then((list) => !disposed && setPanes(list.filter((p) => !p.id.startsWith('companion-'))))
        .catch(() => {});
    refresh();
    for (const sub of [tauri.onPanesChanged(refresh), tauri.onPtyStatus(refresh), cockpitApi.onMiniBarShown((e) => showToast(e.toastMs))]) {
      void sub.then((off) => (disposed ? off() : offs.push(off)));
    }
    cockpitApi.miniBarToastLeft().then(showToast).catch(() => {});
    return () => {
      disposed = true;
      window.clearTimeout(timer.current);
      offs.forEach((off) => off());
    };
  }, [showToast]);

  // Close through the app's normal close path (kill_pane_cmd: the pane and the helpers it started), then re-read the list.
  const closePane = useCallback((id: string) => {
    setPanes((cur) => cur.filter((p) => p.id !== id));
    void tauri
      .killPane(id)
      .catch(() => {})
      .then(() => tauri.listPanes())
      .then((list) => setPanes(list.filter((p) => !p.id.startsWith('companion-'))))
      .catch(() => {});
  }, []);
  const wantWidth = useCallback((px: number) => void cockpitApi.miniBarFit(Math.ceil(px)).catch(() => {}), []);

  const toOrchestration = () => void cockpitApi.setUiMode('orchestration').catch(() => {});
  return (
    <MiniBar
      panes={panes}
      toast={toast}
      onFocusPane={(id) => void cockpitApi.miniBarFocusPane(id).catch(() => {})}
      onClosePane={closePane}
      onWantWidth={wantWidth}
      onNew={toOrchestration}
      onBack={toOrchestration}
      onUndo={toOrchestration}
      labelOf={(id) => listing.agents.find((a) => a.id === id)?.label || agentName(id)}
    />
  );
}
