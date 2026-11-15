// What a Potato Worker address can do. The Worker says so itself (`/_pm/health` lists its features); the app asks
// before it offers an address in a second place and before it sends anything to it.
import { invoke } from '@tauri-apps/api/core';
import { tauri } from './tauri';

export type WorkerFeature = 'team' | 'rooms' | 'stable-link' | 'invites';

export interface WorkerHealth {
  reachable: boolean;
  features: string[];
  /** An older Worker deployed only for the stable link. */
  legacyLink: boolean;
}

export type WorkerVerdict =
  /** The Worker lists the feature. */
  | 'ok'
  /** Reachable, but an older deploy without the feature: "Update your Worker". */
  | 'update'
  /** Did not answer. */
  | 'unreachable'
  /** Could not ask (no desktop shell): the person's choice stands. */
  | 'unknown';

const isTauri = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** Asks the Worker what it can do (plain GETs, nothing secret). Null where the desktop shell is missing. */
export async function workerCheck(address: string): Promise<WorkerHealth | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<WorkerHealth>('worker_check', { address });
  } catch {
    return { reachable: false, features: [], legacyLink: false };
  }
}

export function verdictFor(health: WorkerHealth | null, feature: WorkerFeature): WorkerVerdict {
  if (!health) return 'unknown';
  if (!health.reachable) return 'unreachable';
  return health.features.includes(feature) ? 'ok' : 'update';
}

/** `https://name.workers.dev` for a Worker address, or null for anything else (a path, a port, another host). */
export function workersDevAddress(raw: string | null | undefined): string | null {
  const url = (raw ?? '').trim().replace(/\/+$/, '');
  return /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.workers\.dev$/i.test(url) ? url : null;
}

/** The Worker address saved for the phone link (Settings > Connect), when it is a workers.dev address. */
export async function savedLinkWorker(): Promise<string | null> {
  const status = await tauri.getTunnelStatus();
  return status?.config.mode === 'stable' ? workersDevAddress(status.config.url) : null;
}
