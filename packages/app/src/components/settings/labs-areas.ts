// The Labs page's areas and which early feature sits in which one. Pure data: the rows, their keys and their
// order stay where they are (sections/GeneralSection.tsx and friends; arrange.ts pins the order). A feature this
// file does not name lands in Other.
import type { Settings } from '@potato-workspace/shared';

export const LABS_AREAS = ['Chat', 'Helpers', 'Devices', 'Team', 'Phone', 'Other'] as const;
export type LabsArea = (typeof LABS_AREAS)[number];

const AREA_OF: Record<string, LabsArea> = {
  'live-updates': 'Chat',
  'markup-bar-labs': 'Chat',
  'dock-browser-labs': 'Helpers',
  missions: 'Helpers',
  'assign-issue': 'Helpers',
  'night-shift': 'Helpers',
  'red-to-green': 'Helpers',
  'agent-browser-labs': 'Helpers',
  'project-guide-labs': 'Helpers',
  'crews-labs': 'Helpers',
  'workflows-labs': 'Helpers',
  'workflow-reply-labs': 'Helpers',
  'devices-labs': 'Devices',
  'far-pcs-labs': 'Devices',
  'account-labs': 'Devices',
  'lend-labs': 'Devices',
  'spaces-labs': 'Team',
  'discord-bot-labs': 'Phone',
  'opentunnel-labs': 'Phone',
  telegram: 'Phone',
};

/** The area of an early feature (anything not named is Other). */
export function labsAreaOf(id: string): LabsArea {
  return AREA_OF[id] ?? 'Other';
}

/**
 * The features that are one plain on/off switch, and the saved key each one writes. The Labs page draws these
 * switches itself; it saves them through the same `patch` the feature's own row uses. The rest get an Open button.
 */
export const LABS_SWITCH_KEYS: Partial<Record<string, keyof Settings>> = {
  'simple-mode': 'simple_mode',
  missions: 'missions_enabled',
  'night-shift': 'night_shift_enabled',
  'spaces-labs': 'spaces_enabled',
  'lend-labs': 'lend_enabled',
  'devices-labs': 'devices_enabled',
  'far-pcs-labs': 'far_pcs_enabled',
  'account-labs': 'account_enabled',
  'desktop-potato-labs': 'desktop_pet_enabled',
  'agent-browser-labs': 'agent_browser_enabled',
  'companion-vault-labs': 'companion_vault_enabled',
  'discord-bot-labs': 'discord_bot_enabled',
  'timeline-labs': 'timeline_day_enabled',
  'project-guide-labs': 'project_guide_enabled',
  'markup-bar-labs': 'markup_bar_enabled',
  'dock-browser-labs': 'dock_browser_enabled',
  'smaller-updates-labs': 'smaller_updates_enabled',
  'crews-labs': 'crews_enabled',
  'workflows-labs': 'workflows_enabled',
  'opentunnel-labs': 'opentunnel_stable_link',
};
