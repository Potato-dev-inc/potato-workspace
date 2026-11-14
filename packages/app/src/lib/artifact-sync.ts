// A chat that is not working any more may have pages in `<project>/.potato/artifacts/` that no card tells about (an
// agent that can only write files). Asking the PC to look makes a card appear for each. It runs when the chat settles
// (its status changes to anything but running), never while a turn is writing.
import { useEffect } from 'react';
import { artifactsApi, type ArtifactsApi } from './artifacts';

export function useArtifactSync(paneId: string, enabled: boolean, status: string, api: ArtifactsApi = artifactsApi): void {
  useEffect(() => {
    if (!enabled || status === 'running') return;
    api.sync(paneId).catch(() => undefined);
  }, [api, paneId, enabled, status]);
}
