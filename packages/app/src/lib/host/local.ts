// This PC: the Tauri commands and events, as the screen has always called them. The only place (with the window-only code
// that never runs for a project) that may import `@tauri-apps/api`.
import { invoke } from '@tauri-apps/api/core';
import { listen } from '../events';
import { ALL_CAPS, type Host } from './host';

const isTauri = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export const localHost: Host = {
  place: { kind: 'local' },
  get live() {
    return isTauri();
  },
  async invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    if (!isTauri()) throw new Error(`Desktop shell required: ${cmd}`);
    return invoke<T>(cmd, args);
  },
  async listen<T>(event: string, cb: (payload: T) => void) {
    if (!isTauri()) return () => {};
    return listen<T>(event, (e) => cb(e.payload));
  },
  caps: ALL_CAPS,
};
