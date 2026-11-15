// "Move to…" in the chat menu: move one chat to another paired device (Devices phase 5). The Rust side (`chat_move`) keeps the
// near side's book (the lock, the "Moved to…" note), makes the history text and the git bundle; the far device is driven
// here through the ordinary PC link, so the far device's own rights decide. Sign-ins never move.
//
// Order of a move: begin (locks, refuses while a reply runs) -> history text -> [work: bundle to the far project] -> start a
// chat there -> send the history as its first message -> finish (the old chat becomes read-only). Any failure undoes the lock.
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { t } from '../i18n';
import type { BridgeClient } from './bridge-types';
import { type Device, type DevicesApi } from './devices';
import { errorSentence } from './sayError';

export type MoveMode = 'history' | 'work';

export type MoveStatus =
  | { state: 'none' }
  | { state: 'moving'; mode: MoveMode }
  | { state: 'moved'; node: string; device: string; far_pane: string; at: number; mode: MoveMode };

export interface MoveBegun {
  agentType: string;
  agentLabel: string;
}

export interface MoveWorkReady {
  branch: string;
  sha: string;
  bundleB64: string;
  size: number;
}

/** What the window needs from the desktop shell (a fake in tests). */
export interface MoveApi {
  status: (paneId: string) => Promise<MoveStatus>;
  /** Locks the chat. Rejects with a plain sentence (a reply is running, not a git project, already moved). */
  begin: (paneId: string, mode: MoveMode) => Promise<MoveBegun>;
  /** The first message for the new agent: the history as text. */
  history: (paneId: string, fromDevice: string) => Promise<{ text: string }>;
  prepareWork: (paneId: string) => Promise<MoveWorkReady>;
  finish: (paneId: string, node: string, device: string, farPane: string) => Promise<void>;
  abort: (paneId: string) => Promise<void>;
  /** The note or the lock of a chat changed. */
  onChanged: (cb: (paneId: string) => void) => Promise<UnlistenFn>;
}

const isTauri = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) return Promise.reject(new Error(`Desktop shell required: ${command}`));
  return invoke<T>(command, args);
}

export const tauriMoveApi: MoveApi = {
  status: (paneId) => call('chat_move_status', { paneId }),
  begin: (paneId, mode) => call('chat_move_begin', { paneId, mode }),
  history: (paneId, fromDevice) => call('chat_move_history', { paneId, fromDevice }),
  prepareWork: (paneId) => call('chat_move_prepare_work', { paneId }),
  finish: (paneId, node, device, farPane) => call('chat_move_finish', { paneId, node, device, farPane }),
  abort: (paneId) => call('chat_move_abort', { paneId }),
  onChanged: (cb) => (isTauri() ? listen<string>('chat-move://changed', (e) => cb(e.payload)).catch(() => () => {}) : Promise.resolve(() => {})),
};

/** Asks the cockpit to open a chat that runs on another device ("Open it there"). */
export const OPEN_REMOTE_EVENT = 'pm:open-remote-chat';

export function requestOpenRemote(node: string, paneId: string): void {
  window.dispatchEvent(new CustomEvent<{ node: string; paneId: string }>(OPEN_REMOTE_EVENT, { detail: { node, paneId } }));
}

/** Why the message box of a chat is off because of a move, or null. */
export function moveBlock(status: MoveStatus): string | null {
  if (status.state === 'moving') return t('move.locked');
  if (status.state === 'moved') return t('move.readOnly', { name: status.device });
  return null;
}

/** The one line under a chat that moved: `Moved to Mac mini at 14:20`. */
export function movedLine(status: Extract<MoveStatus, { state: 'moved' }>): string {
  const d = new Date(status.at * 1000);
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return t('move.movedAt', { name: status.device, time });
}

/** Whether the far device can take a move at all, and the plain reason when it cannot. */
export function whyNotDevice(d: Device): string | null {
  if (d.state !== 'online') return null; // the picker shows its own state sentence
  if (d.too_old) return null;
  if (d.level !== 'full') return t('move.needsControl', { name: d.name });
  return null;
}

/** What the far device offers to start a chat in, from `GET /phone/new-chat`. */
export interface FarOptions {
  agents: { id: string; label: string }[];
  projects: { id: string; name: string }[];
}

export async function farOptions(bridge: BridgeClient): Promise<FarOptions> {
  if (!bridge.phoneNewChat) throw new Error(t('move.noAgents', { name: '' }).trim());
  const o = await bridge.phoneNewChat();
  return {
    agents: o.agents.filter((a) => a.chat).map((a) => ({ id: a.id, label: a.label })),
    projects: o.projects.filter((p) => p.state !== 'missing').map((p) => ({ id: p.id, name: p.name })),
  };
}

export interface MoveRequest {
  paneId: string;
  mode: MoveMode;
  /** The far device and its client (a far bridge call goes through the link). */
  device: Device;
  bridge: BridgeClient;
  devices: Pick<DevicesApi, 'request'>;
  api: MoveApi;
  /** This PC's own name, so the new agent can say where the chat came from. */
  fromName: string;
  /** The far agent and project (ids the far device gave). */
  agent: string;
  project: string;
}

/** The sentence a far answer carries (`{ error }`), else a plain fallback. */
function farSentence(body: unknown, fallback: string): string {
  const error = (body as { error?: unknown } | null)?.error;
  return typeof error === 'string' && error.trim() ? error.trim().slice(0, 300) : fallback;
}

/**
 * Does the move. Resolves with the chat's id on the far device. Rejects with one plain sentence; the chat is then open
 * again here and nothing of it changed (a far chat that was started is closed again when it can be).
 */
export async function runMove(r: MoveRequest): Promise<{ farPane: string }> {
  await r.api.begin(r.paneId, r.mode);
  let farPane: string | null = null;
  try {
    const history = await r.api.history(r.paneId, r.fromName);
    if (r.mode === 'work') {
      const work = await r.api.prepareWork(r.paneId);
      const sent = await r.devices.request(r.device.node, 'POST', '/phone/move-work', { project: r.project, branch: work.branch, bundle_b64: work.bundleB64 });
      if (sent.status !== 200) throw new Error(farSentence(sent.body, t('move.failed')));
    }
    if (!r.bridge.phoneStartChat || !r.bridge.sendPaneMessage) throw new Error(t('move.failed'));
    farPane = (await r.bridge.phoneStartChat({ agent: r.agent, project: r.project, lane: 'chat' })).pane_id;
    try {
      await r.bridge.sendPaneMessage(farPane, history.text);
    } catch {
      throw new Error(t('move.notArrived', { name: r.device.name }));
    }
    await r.api.finish(r.paneId, r.device.node, r.device.name, farPane);
    return { farPane };
  } catch (error) {
    if (farPane) void r.bridge.killPane(farPane).catch(() => undefined);
    await r.api.abort(r.paneId).catch(() => undefined);
    throw new Error(errorSentence(error));
  }
}
