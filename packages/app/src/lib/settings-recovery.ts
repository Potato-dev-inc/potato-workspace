// "Restore the last good settings": the page's side of the settings safety net (Rust: settings_safety). The app keeps
// up to five saved copies of settings.json; if the file was damaged at start, the Settings page offers to bring one back.
import { invoke } from '@tauri-apps/api/core';

export interface SettingsRecoveryStatus {
  /** settings.json could not be read when the app started. */
  damaged: boolean;
  /** A saved copy that reads well exists. */
  hasBackup: boolean;
}

export interface SettingsRecoveryApi {
  status(): Promise<SettingsRecoveryStatus>;
  /** Brings back the newest good copy and loads it into the running app. Rejects with a plain sentence. */
  restore(): Promise<void>;
  /** Hides the damaged-file line for this run. */
  dismiss(): Promise<void>;
}

export const settingsRecoveryApi: SettingsRecoveryApi = {
  status: () => invoke<SettingsRecoveryStatus>('settings_recovery_status'),
  restore: () => invoke<void>('settings_restore_last_good'),
  dismiss: () => invoke<void>('settings_recovery_dismiss'),
};

export const RECOVERY_LABEL = 'Restore the last good settings';
export const RECOVERY_HINT = 'Brings back a saved copy of your settings if they were lost or damaged.';
export const DAMAGED_LINE = 'Your settings file was damaged, so the app started with its defaults. A copy was kept aside.';
