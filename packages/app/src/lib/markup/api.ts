// The two calls the mark-up bar makes to this PC (a test double can stand in): take the picture of the page area, and send the
// message with that picture to the chat that owns the page.
import { invoke } from '@tauri-apps/api/core';

export interface StageRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What the PC answers after it took the picture. `thumb` is a small data address for the send row (null when it is too big). */
export interface MarkupShot {
  shotId: string;
  thumb: string | null;
}

export interface MarkupApi {
  /** Takes a picture of this window's page area (`rect`, in CSS pixels of a window `viewportW` wide). It shows only this window. */
  capture(paneId: string, rect: StageRect, viewportW: number): Promise<MarkupShot>;
  /** Sends `text` to the chat of `paneId` with the picture `shotId` (an attachment for a chat agent, a file name for a terminal agent). */
  send(paneId: string, shotId: string | null, text: string): Promise<unknown>;
}

export const markupApi: MarkupApi = {
  capture: (paneId, rect, viewportW) => invoke<MarkupShot>('markup_capture', { paneId, rect, viewportW }),
  send: (paneId, shotId, text) => invoke('markup_send', { paneId, shotId, text }),
};
