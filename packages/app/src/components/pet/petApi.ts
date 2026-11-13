// Desktop Potato: the few calls to the app. Everything fails quietly: the pet is never worth an error.
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { cockpitApi } from '../../lib/cockpit-api';
import { patchSettings } from '../../lib/settings';
import type { PetEnv } from './usePetController';

export interface PetApi {
  env: Pick<PetEnv, 'moveBy' | 'fullscreenBusy'>;
  setExpanded: (expanded: boolean) => void;
  startDrag: () => void;
  openAgent: (paneId?: string) => void;
  patch: (patch: Record<string, unknown>) => void;
  /** A drag has settled (the window stopped moving). */
  onMoved: (cb: () => void) => Promise<UnlistenFn>;
}

const quiet = <T>(promise: Promise<T>): void => void promise.catch(() => undefined);

export const tauriPetApi: PetApi = {
  env: {
    moveBy: (dx) => invoke<boolean>('pet_move_by', { dx }).catch(() => true),
    fullscreenBusy: () => invoke<boolean | null>('pet_fullscreen_busy').catch(() => null),
  },
  setExpanded: (expanded) => quiet(invoke('pet_set_expanded', { expanded })),
  startDrag: () => quiet(invoke('pet_start_drag')),
  openAgent: (paneId) => quiet(cockpitApi.openCockpit(paneId)),
  patch: (patch) => quiet(patchSettings(patch)),
  onMoved: (cb) => listen('pet://moved', () => cb()),
};
