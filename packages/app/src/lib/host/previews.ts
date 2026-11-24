// Dev-server previews of ONE place. This PC's come from `usePanePreviews` (the cockpit already holds them). Another PC lists the ports of its own
// chats (`pane_previews`) and shows one in a preview window of its own: the page is fetched through the PC link and handed to the window by the
// app's `pmfar` protocol, so no port opens on this PC (`device_link/far_preview.rs`). Never the far PC's `localhost` address on this PC's loopback.
import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';
import { openPreview, type PreviewMap, type PreviewUrl } from '../pane-preview';
import { pointApi } from '../point-api';
import { useHost } from './context';
import type { Host } from './host';
import { idOfKey, placeKey } from './placeKey';

const NONE: PreviewMap = {};
/** The far list is read again this often (a dev server starts and stops without a message). */
export const FAR_PREVIEWS_POLL_MS = 5000;
/** ...and this often while it lists none (the usual idle chat); nothing is asked while the window is hidden. */
export const FAR_PREVIEWS_IDLE_POLL_MS = 15_000;

/** The previews another PC lists, keyed as this screen holds its chats; empty for this PC (its previews are the cockpit's). */
export function useHostPreviews(): PreviewMap {
  const host = useHost();
  const [map, setMap] = useState<PreviewMap>(NONE);
  const far = host.place.kind !== 'local' && host.caps.preview && host.can?.('pane_previews') !== false;
  useEffect(() => {
    if (!far) {
      setMap(NONE);
      return;
    }
    let live = true;
    let found = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = (): Promise<unknown> =>
      host.invoke<Record<string, PreviewUrl[]>>('pane_previews').then(
        (rows) => {
          found = Object.keys(rows ?? {}).length > 0;
          if (live) setMap(Object.fromEntries(Object.entries(rows ?? {}).map(([id, urls]) => [placeKey(host.place, id), urls])));
        },
        () => {
          found = false;
          if (live) setMap(NONE);
        },
      );
    const next = () => {
      timer = setTimeout(() => {
        // A hidden window asks nothing; it reads again at the next tick once it is back.
        if (typeof document !== 'undefined' && document.hidden) return next();
        void read().then(next);
      }, found ? FAR_PREVIEWS_POLL_MS : FAR_PREVIEWS_IDLE_POLL_MS);
    };
    void read().then(next);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [host, far]);
  return map;
}

/** Opens the preview of chat `paneId` (its key on this screen) at `port`: this PC's own window, or the far one. `armed` (the picker) is this PC's only. */
export function openPreviewOn(host: Host, paneId: string, port: number, armed = false): Promise<unknown> {
  if (host.place.kind === 'local') return pointApi.openPreview(paneId, port, armed);
  return invoke<void>('far_preview_open', { node: host.place.node, pane_id: idOfKey(host.place.node, paneId), port });
}

/** "Open in the browser": this PC's browser for this PC's dev server; for another PC's it is the same preview window (its `localhost` is not ours). */
export function openPreviewInBrowserOn(host: Host, paneId: string, preview: PreviewUrl): Promise<unknown> {
  return host.place.kind === 'local' ? openPreview(preview.url) : openPreviewOn(host, paneId, preview.port);
}

