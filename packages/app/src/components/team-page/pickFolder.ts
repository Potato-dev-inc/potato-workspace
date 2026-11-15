import { open as openDialog } from '@tauri-apps/plugin-dialog';

/** Opens the system folder picker. Null when the person cancels or there is no desktop shell. */
export type FolderPicker = (start?: string | null) => Promise<string | null>;

export const pickFolder: FolderPicker = async (start) => {
  try {
    const picked = await openDialog({ directory: true, multiple: false, defaultPath: start || undefined });
    return typeof picked === 'string' ? picked : null;
  } catch {
    return null;
  }
};
