// What's new "Try it" for the things that live in a chat pane: the right panel, a page beside the chat, a file, Point.
// The pane on screen registers them while it is mounted (whatsnew/registry.ts); with no chat open they answer
// "missing" and the tour says so in plain words.
import { artifactsApi, type ArtifactsApi } from '../../lib/artifacts';
import { openArtifactBeside, requestArtifactPoint } from '../../lib/artifact-side';
import { openFileTab } from '../../lib/file-tabs';
import { searchProjectFiles, type ProjectFileHit } from '../../lib/projectFiles';
import { useRegisterAction } from '../../whatsnew/registry';
import { setRailSectionClosed } from './rail/railFold';
import type { RailLayout } from './rail/useRailLayout';

export interface PaneTourDeps {
  artifacts?: Pick<ArtifactsApi, 'sync'>;
  search?: (paneId: string, query: string, limit?: number) => Promise<ProjectFileHit[]>;
}

/** The page the agent made last in this chat's project, or null. */
async function newestPage(paneId: string, api: Pick<ArtifactsApi, 'sync'>): Promise<string | null> {
  try {
    const list = await api.sync(paneId);
    const sorted = [...list].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return sorted[0]?.id ?? null;
  } catch {
    return null;
  }
}

export function usePaneTourActions(paneId: string, rail: RailLayout, deps: PaneTourDeps = {}): void {
  const artifacts = deps.artifacts ?? artifactsApi;
  const search = deps.search ?? searchProjectFiles;
  const showRail = (): boolean => {
    if (!rail.fits) return false;
    if (!rail.open) rail.toggle();
    return true;
  };
  useRegisterAction('rail.open', showRail);
  useRegisterAction('artifact.sample', () => {
    void newestPage(paneId, artifacts).then((id) => id && openArtifactBeside(id, paneId));
    return true;
  });
  useRegisterAction('point.start', () => {
    void newestPage(paneId, artifacts).then((id) => {
      if (!id) return;
      requestArtifactPoint(paneId);
      openArtifactBeside(id, paneId);
    });
    return true;
  });
  useRegisterAction('files.sample', (args) => {
    if (!showRail()) return false;
    setRailSectionClosed('files', false);
    const kind = typeof args.kind === 'string' && /^[a-z0-9]{1,5}$/.test(args.kind) ? args.kind : '';
    if (kind) {
      // A sample of that kind, if the project has one; otherwise the Files card is simply on show.
      void search(paneId, `.${kind}`, 1).then((hits) => hits[0] && openFileTab(paneId, hits[0].path), () => undefined);
    }
    return true;
  });
}
