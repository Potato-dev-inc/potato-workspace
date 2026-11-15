// Root of an artifact's own window (route `index.html?artifactwin=1&pane=..&id=..`, label `artifact-window-<id>`): one page
// with its own tools (Point, Share, versions). Point sends to the chat that made the page, the same as beside the chat.
import { useEffect, useState } from 'react';
import { applyTheme, loadSettings, type AppTheme } from '../../lib/settings';
import { subscribeSettingsTheme } from '../../lib/settings-sync';
import { ArtifactTab } from './ArtifactTab';

export default function ArtifactWindowApp() {
  const params = new URLSearchParams(window.location.search);
  const paneId = params.get('pane') ?? '';
  const id = params.get('id') ?? '';
  const [theme, setTheme] = useState<AppTheme>('dark');
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
  return (
    <div className="cockpit ck-artwin" data-theme={theme}>
      {paneId && id ? <ArtifactTab paneId={paneId} id={id} /> : null}
    </div>
  );
}
