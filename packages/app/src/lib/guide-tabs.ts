// The Guide tab is a tab of the pane, in the same row as the open files (`file-tabs.ts`). Its tab path is `guide:`.
import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { closeFileTab, openFileTab } from './file-tabs';
import { loadSettings } from './settings';

const inTauri = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export const GUIDE_TAB_PATH = 'guide:';

export const isGuidePath = (path: string): boolean => path === GUIDE_TAB_PATH;

export function openGuideTab(paneId: string): void {
  openFileTab(paneId, GUIDE_TAB_PATH);
}

export function closeGuideTab(paneId: string): void {
  closeFileTab(paneId, GUIDE_TAB_PATH);
}

/** The palette rows for the guide: none while the Labs switch is off. Both open the Guide tab (it shows the card to make one, or the guide). */
export function guidePaletteRows(enabled: boolean): { id: string; title: string; keywords: string }[] {
  if (!enabled) return [];
  return [
    { id: 'act:guide-open', title: 'Open project guide', keywords: 'project guide wiki overview map architecture docs read' },
    { id: 'act:guide-make', title: 'Make project guide', keywords: 'project guide wiki overview map architecture docs write make create refresh' },
  ];
}

/** Is the Labs switch on? (Settings, or a development build.) Off until the app answers. */
export function useGuideEnabled(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!inTauri()) return;
    let disposed = false;
    let off: (() => void) | undefined;
    const read = () =>
      loadSettings().then(
        (s) => !disposed && setOn((s as { project_guide_enabled?: boolean }).project_guide_enabled === true),
        () => undefined,
      );
    void read();
    listen('settings://changed', () => void read())
      .then((un) => (disposed ? un() : (off = un)))
      .catch(() => undefined);
    return () => {
      disposed = true;
      off?.();
    };
  }, []);
  return on;
}
