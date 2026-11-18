// The two ends of the "Marked up" card: the cockpit listens for the app's own `markup://sent` event and records the
// message (before it is sent), and a chat reads the records of its pane and redraws when a new one is stored.
import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { onMarkupSendsChanged, readMarkupSends, recordFromEvent, type MarkupSend } from '../lib/markupCard';

/** Mount once in the cockpit. A failed listen (a browser preview, a test) just means no cards. */
export function useMarkupSendRecorder(): void {
  useEffect(() => {
    let off: (() => void) | undefined;
    let gone = false;
    try {
      void listen('markup://sent', (event) => recordFromEvent(event.payload))
        .then((un) => (gone ? un() : (off = un)))
        .catch(() => undefined);
    } catch {
      /* not inside the app */
    }
    return () => {
      gone = true;
      off?.();
    };
  }, []);
}

export function useMarkupSends(paneId: string | null | undefined): readonly MarkupSend[] {
  const [sends, setSends] = useState<readonly MarkupSend[]>(() => readMarkupSends(paneId));
  useEffect(() => {
    setSends(readMarkupSends(paneId));
    return onMarkupSendsChanged(() => setSends(readMarkupSends(paneId)));
  }, [paneId]);
  return sends;
}
