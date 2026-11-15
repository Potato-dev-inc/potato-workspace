import { tauriUpdateTransport, type UpdateTransport } from '../../lib/app-update';
import { useEffect } from 'react';
import { listenForWhatsNewAsks, useWhatsNewState } from '../../whatsnew/store';
import { TourDialog } from '../whatsnew/TourDialog';
import { ToolsMissingNotice } from './ToolsMissingNotice';
import { UpdateNoticeView } from './UpdateNotice';
import { useAppUpdate } from './useAppUpdate';
import { WhatsNewCard } from './WhatsNewCard';

/**
 * Mounted once in the app: checks quietly and shows the notice only when there is something to say. It also hosts the
 * What's new tour, which the after-update card, Help, the palette and Settings all open through the same store.
 * `suppressed`: the first-run screens are open, so the after-update card waits. `notify` shows a short toast.
 */
export function AppUpdateHost({ transport = tauriUpdateTransport, suppressed = false, notify }: { transport?: UpdateTransport; suppressed?: boolean; notify?: (text: string) => void }) {
  const state = useAppUpdate(transport);
  const whatsNew = useWhatsNewState();
  // The standalone Settings window asks this window for the tour, the guide and the shortcuts.
  useEffect(() => listenForWhatsNewAsks(), []);
  return (
    <>
      <UpdateNoticeView state={state} />
      <ToolsMissingNotice transport={transport} />
      <WhatsNewCard transport={transport} suppressed={suppressed} notify={notify} />
      {whatsNew.tour && <TourDialog version={whatsNew.tour.version} notify={notify} />}
    </>
  );
}
