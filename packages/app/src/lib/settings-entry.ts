// Entry route of the standalone Settings window (`index.html?settings=1&tab=agents`), opened by the
// Rust side (tray, second launch, palette). Pure so it can be tested without a webview.
import { SECTION_IDS, type SettingsPageId } from '../components/settings/model';

export const DEFAULT_SETTINGS_TAB: SettingsPageId = 'overview';

/**
 * Old tab ids that callers may still send, and where each one lives now: the 22 tabs of the first Settings, the
 * nine sections of the second (`general`, `models`, `bridge`, `phone`, `team`, `lend`), and the old "Coming
 * later" words (they open Overview).
 */
export const LEGACY_TABS: Record<string, SettingsPageId> = {
  general: 'look',
  models: 'advanced',
  bridge: 'advanced',
  phone: 'connect',
  team: 'connect',
  lend: 'connect',
  later: 'overview',
  appearance: 'look',
  storage: 'advanced',
  advanced: 'advanced',
  preload: 'agents',
  session: 'advanced',
  orchestrator: 'advanced',
  api: 'keys',
  mcp: 'advanced',
  developer: 'advanced',
  mobile: 'connect',
  security: 'agents',
  notifications: 'overview',
  backup: 'overview',
  marketplace: 'overview',
  rules: 'overview',
  costs: 'overview',
  automation: 'overview',
  observability: 'overview',
  plugins: 'advanced',
};

export function isSettingsEntry(search: string): boolean {
  return new URLSearchParams(search).has('settings');
}

/** A page id from a section id or an old tab id; null when it names nothing. */
export function resolveSettingsTab(tab: string | null | undefined): SettingsPageId | null {
  if (!tab) return null;
  if ((SECTION_IDS as readonly string[]).includes(tab)) return tab as SettingsPageId;
  return LEGACY_TABS[tab] ?? null;
}

/** The page named by `?tab=`, or Overview when absent or unknown. */
export function settingsEntryTab(search: string): SettingsPageId {
  return resolveSettingsTab(new URLSearchParams(search).get('tab')) ?? DEFAULT_SETTINGS_TAB;
}
