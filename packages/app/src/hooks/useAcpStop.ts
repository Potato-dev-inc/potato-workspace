// The Stop of a chat session over ACP, shared by the message box (its Stop button) and the dock under the conversation
// (the "No answer" question). `asked`: the person pressed Stop and the backend's state has not come back yet, so the
// words already read "Stopping…".
import { useCallback, useEffect, useState } from 'react';
import type { AcpChatApi } from '../lib/acpChat';

export interface AcpStop {
  asked: boolean;
  stop: () => void;
}

export function useAcpStop(paneId: string, running: boolean, api: Pick<AcpChatApi, 'cancel'>): AcpStop {
  const [asked, setAsked] = useState(false);
  useEffect(() => {
    if (!running) setAsked(false);
  }, [running]);
  useEffect(() => setAsked(false), [paneId]);
  const stop = useCallback(() => {
    setAsked(true);
    api.cancel(paneId).catch(() => setAsked(false));
  }, [api, paneId]);
  return { asked, stop };
}
