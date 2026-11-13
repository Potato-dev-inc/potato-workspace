// One-click update. The app asks its own backend (Tauri updater: a signed MSI named in the GitHub release's latest.json);
// this file is the page's side: what the backend answers, how to read versions, and plain words for what went wrong.
import { invoke } from '@tauri-apps/api/core';
import { t } from '../i18n';

/** What the backend found when it checked. `null` means this version is the newest. */
export interface UpdateOffer {
  currentVersion: string;
  version: string;
  notes: string | null;
}

/** Who is working (or waiting for you) now. Chats come back after the restart; terminal agents do not. */
export interface UpdateBusyInfo {
  agents: string[];
  chats: string[];
  terminals: string[];
}

/** How far the download is. `total` is null when the server did not say. */
export interface UpdateProgress {
  downloaded: number;
  total: number | null;
}

export interface UpdateTransport {
  /** Reads the release's latest.json. Rejects with a plain sentence (no network, nothing found). */
  check(): Promise<UpdateOffer | null>;
  /** Names of the agents that are working or waiting for you now. */
  busy(): Promise<string[]>;
  /** Same, split into chats and terminals. Absent in older transports (then `busy` is used). */
  busyInfo?(): Promise<UpdateBusyInfo>;
  /**
   * Downloads and checks the signature. If an agent is working it then rejects with `UPDATE_RUNNING` and keeps the
   * download; with `confirmRunning` it stops the agents cleanly and installs. Rejects with a plain sentence.
   */
  install(confirmRunning: boolean): Promise<void>;
  /** Download progress while `install` runs. Resolves with the way to stop listening. */
  onProgress?(callback: (progress: UpdateProgress) => void): Promise<() => void>;
  /** After `UPDATE_STOPPED`: brings the stopped chats back. Terminal agents are not reopened. */
  reopenChats?(): Promise<void>;
}

export const tauriUpdateTransport: UpdateTransport = {
  check: () => invoke<UpdateOffer | null>('app_update_check'),
  busy: async () => (await invoke<{ agents: string[] }>('app_update_busy')).agents,
  busyInfo: async () => {
    const info = await invoke<Partial<UpdateBusyInfo>>('app_update_busy');
    return { agents: info.agents ?? [], chats: info.chats ?? [], terminals: info.terminals ?? [] };
  },
  install: (confirmRunning) => invoke<void>('app_update_install', { confirmRunning }),
  onProgress: async (callback) => {
    const { listen } = await import('@tauri-apps/api/event');
    return listen<{ downloaded: number; total: number | null }>('app-update-progress', (event) => callback(event.payload));
  },
  reopenChats: () => invoke<void>('app_update_install', { confirmRunning: false, reopenChats: true }),
};

/** The code at the start of a backend error ("UPDATE_RUNNING: ..."), or null for a plain sentence. */
export function updateErrorCode(error: unknown): 'UPDATE_RUNNING' | 'UPDATE_STOPPED' | null {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const match = /^(UPDATE_RUNNING|UPDATE_STOPPED):/.exec(raw.trim());
  return match ? (match[1] as 'UPDATE_RUNNING' | 'UPDATE_STOPPED') : null;
}

/** Whole percent for a progress reading, or null when the total is not known. */
export function progressPercent(progress: UpdateProgress): number | null {
  if (!progress.total || progress.total <= 0) return null;
  return Math.max(0, Math.min(100, Math.floor((progress.downloaded * 100) / progress.total)));
}

export function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, '');
}

export function parseVersionParts(version: string): number[] {
  return normalizeVersion(version)
    .split(/[.-]/)
    .map((part) => {
      const match = /^(\d+)/.exec(part);
      return match ? Number.parseInt(match[1], 10) : 0;
    });
}

/** True when `latest` is strictly newer than `current`. */
export function isVersionNewer(latest: string, current: string): boolean {
  const a = parseVersionParts(latest);
  const b = parseVersionParts(current);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    if (left !== right) return left > right;
  }
  return false;
}


/** A sentence for the page. Backend errors already are sentences; anything else (a code, a stack) becomes the fallback. */
export function plainUpdateError(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const text = raw.replace(/^[A-Z_]{3,}:\s*/, '').trim();
  if (!text || /[\\/]|Error:|at \w/.test(text)) return t('overview.update.fallback');
  return text;
}

/**
 * The sentence when an agent is working or waiting for you: it says which agents stop, and that chats come back after
 * the restart while terminal agents do not. Without the split (an older backend) it says only that they stop.
 */
export function runningJobWarning(agents: string[], split?: { chats: string[]; terminals: string[] }): string {
  const who = agents.length === 1 ? t('overview.update.oneAgent') : t('overview.update.manyAgents', { count: agents.length });
  const names = agents.length > 0 ? ` (${agents.join(', ')})` : '';
  const lead = t('overview.update.stillWorking', { who, names, them: agents.length === 1 ? t('overview.update.it') : t('overview.update.them') });
  if (!split) return lead;
  const parts = [lead];
  if (split.chats.length > 0) parts.push(t('overview.update.chatsSaved', { list: split.chats.join(', ') }));
  if (split.terminals.length > 0) parts.push(t('overview.update.terminalsStop', { list: split.terminals.join(', ') }));
  return parts.join(' ');
}
