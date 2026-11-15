// The agent's Remote control rule: whether paired phones can reach it. The bridge enforces the rule for every phone
// request; the right panel only sets it.
import type { PairedDeviceInfo } from '@potato-workspace/shared';
import type { PaneRemote, PaneRemoteLevel } from '../../../lib/pane-remote';
import { tauri } from '../../../lib/tauri';

export interface RemoteApi {
  get: (paneId: string) => Promise<PaneRemote>;
  set: (paneId: string, change: { remote?: boolean; level?: PaneRemoteLevel }) => Promise<PaneRemote>;
  phones: () => Promise<PairedDeviceInfo[]>;
}

export const tauriRemoteApi: RemoteApi = {
  get: (paneId) => tauri.getPaneRemote(paneId),
  set: (paneId, change) => tauri.setPaneRemote(paneId, change),
  phones: () => tauri.listPairedMobileDevices(),
};
