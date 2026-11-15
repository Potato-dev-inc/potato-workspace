// The desktop's way to read the device names (the app window only; a browser tab has none).
import { invoke } from '@tauri-apps/api/core';
import type { DeviceNameMap } from './deviceNames';

const isTauri = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export const loadDesktopDeviceNames = async (): Promise<DeviceNameMap> => (isTauri() ? invoke<DeviceNameMap>('device_names') : {});
