// Nudge, Stop and Respawn for a stuck helper: one call at a time, and one plain sentence about how it went.
// Used by the notice under a helper's row and by the Inbox card, so both say the same thing.
import { useState } from 'react';
import { useT } from '../../i18n';
import { errorSentence } from '../../lib/sayError';
import { tauriStallApi, type StallApi } from '../../lib/stalls';

export type StallAction = 'nudge' | 'stop' | 'respawn';

export function useStallActions(paneId: string, api: StallApi = tauriStallApi) {
  const t = useT();
  const [busy, setBusy] = useState<StallAction | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const run = async (which: StallAction) => {
    setBusy(which);
    setNote(null);
    try {
      await api[which](paneId);
      setNote(t(which === 'nudge' ? 'stall.nudged' : which === 'stop' ? 'stall.stopped' : 'stall.respawned'));
    } catch (e) {
      setNote(errorSentence(e, t('stall.failed')));
    } finally {
      setBusy(null);
    }
  };
  return { busy, note, run };
}
