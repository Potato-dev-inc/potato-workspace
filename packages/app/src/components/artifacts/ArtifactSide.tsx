// A page the agent made, open BESIDE the chat: a pane between the chat and the right panel. The chat is not touched (it
// stays mounted and keeps its scroll and its draft); this pane only adds a column, resizable by its left edge, or lies
// over the whole row ("full width"), or leaves for a window of its own.
import { useCallback, useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useT } from '../../i18n';
import { artifactsApi } from '../../lib/artifacts';
import {
  ARTSIDE_MAX,
  ARTSIDE_MIN,
  closeArtifactBeside,
  openArtifactBeside,
  resetArtifactSideWidth,
  saveArtifactSideWidth,
  setArtifactFull,
  setArtifactSideWidth,
  sideWidthShown,
  useArtifactSide,
  useArtifactSideWidth,
} from '../../lib/artifact-side';
import { artifactTabPath, artifactTabTitle } from '../../lib/artifact-tabs';
import { useLayout, useWindowInnerWidth } from '../../lib/panel-widths';
import { ResizeHandle } from '../cockpit/ResizeHandle';
import { ArtifactTab } from './ArtifactTab';
import '../../styles/artifacts.css';

export function ArtifactSide({ paneId, railVisible }: { paneId: string; railVisible: boolean }) {
  const t = useT();
  const side = useArtifactSide(paneId);
  const chosen = useArtifactSideWidth();
  const layout = useLayout();
  const windowWidth = useWindowInnerWidth();
  const id = side?.id ?? '';
  const popOut = useCallback(() => {
    // The window shows the page by itself: the side pane lets go of it.
    void artifactsApi.popOut(paneId, id, artifactTabTitle(artifactTabPath(id))).then(() => closeArtifactBeside(paneId), () => undefined);
  }, [paneId, id]);
  // "Back to side pane" in the agent browser tells the chat screen to take the page back.
  useEffect(() => {
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;
    let off: (() => void) | undefined;
    let gone = false;
    listen<{ paneId?: string; id?: string }>('artifact-to-side', (event) => {
      const { paneId: pane, id: page } = event.payload ?? {};
      if (pane === paneId && typeof page === 'string' && /^[a-z0-9][a-z0-9-]{0,47}$/.test(page)) openArtifactBeside(page, paneId);
    })
      .then((un) => (gone ? un() : (off = un)))
      .catch(() => undefined);
    return () => {
      gone = true;
      off?.();
    };
  }, [paneId]);
  if (!side) return null;
  const shown = sideWidthShown(chosen, windowWidth - layout.sidePx, railVisible ? layout.railPx : 0);
  const chrome = { full: side.full, onFull: () => setArtifactFull(paneId, !side.full), onPopOut: popOut, onClose: () => closeArtifactBeside(paneId) };
  return (
    <>
      {!side.full && (
        <ResizeHandle
          className="ck-resize--artside"
          grow="left"
          value={shown}
          min={ARTSIDE_MIN}
          max={ARTSIDE_MAX}
          label={t('artifacts.resize')}
          title={t('artifacts.resizeTip')}
          onChange={setArtifactSideWidth}
          onCommit={saveArtifactSideWidth}
          onReset={resetArtifactSideWidth}
        />
      )}
      <div className={`ck-artside${side.full ? ' ck-artside--full' : ''}`} style={side.full ? undefined : { width: shown }} data-testid="artifact-side" data-full={side.full ? 'true' : undefined}>
        <ArtifactTab key={side.id} paneId={paneId} id={side.id} side={chrome} />
      </div>
    </>
  );
}

