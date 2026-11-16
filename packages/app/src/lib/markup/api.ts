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

/** One running agent in the "send to" list (plain words only; `id` is the key a click sends with and is never drawn). */
export interface MarkupAgent {
  id: string;
  agentId: string;
  name: string;
  task: string;
  project: string;
  status: 'working' | 'waiting' | 'idle' | 'stopped';
  ok: boolean;
  reason: string | null;
}

export interface MarkupTargets {
  rows: MarkupAgent[];
  /** The agent to preselect: the page's own chat, else the newest in its folder. */
  current: string | null;
}

export interface MarkupApi {
  /** Takes a picture of this window's page area (`rect`, in CSS pixels of a window `viewportW` wide). It shows only this window. */
  capture(paneId: string, rect: StageRect, viewportW: number): Promise<MarkupShot>;
  /** Sends `text` to the chat of `paneId` with the picture `shotId` (an attachment for a chat agent, a file name for a terminal agent). */
  send(paneId: string, shotId: string | null, text: string, to?: string): Promise<unknown>;
  /** The running agents the marks can go to. Left out (a test double): no picker, the marks go to the page's chat. */
  targets?(paneId: string): Promise<MarkupTargets>;
}

export const markupApi: MarkupApi = {
  capture: (paneId, rect, viewportW) => invoke<MarkupShot>('markup_capture', { paneId, rect, viewportW }),
  send: (paneId, shotId, text, to) => invoke('markup_send', { paneId, shotId, text, to: to ?? null }),
  targets: (paneId) => invoke<MarkupTargets>('markup_targets', { paneId }),
};
