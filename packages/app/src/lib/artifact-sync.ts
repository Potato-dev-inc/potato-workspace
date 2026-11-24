// A chat that is not working any more may have pages in `<project>/.potato/artifacts/` that no card tells about (an
// agent that can only write files). Asking the PC to look makes a card appear for each. It runs when the chat settles
// (its status changes to anything but running), never while a turn is writing.
import { useEffect, useMemo } from 'react';
import { artifactsApiFor, type ArtifactsApi } from './artifacts';
import { useHost } from './host/context';

export function useArtifactSync(paneId: string, enabled: boolean, status: string, given?: ArtifactsApi): void {
  const host = useHost();
  const api = useMemo(() => given ?? artifactsApiFor(host), [given, host]);
  useEffect(() => {
    if (!enabled || status === 'running') return;
    api.sync(paneId).catch(() => undefined);
  }, [api, paneId, enabled, status]);
}
