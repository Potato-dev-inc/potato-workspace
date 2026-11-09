// Which rows a person sees first. Everything not named here is `advanced`: it sits under its section's closed
// "Advanced" group. `developer` rows show only while "Show developer settings" is on (General > Advanced).
// Search finds every level. Keep the basic list short: the test in catalog.test.ts caps it per section.
import type { RowLevel } from './model';

export const BASIC_ROW_IDS: readonly string[] = [
  // General
  'your-name',
  'theme',
  'project-folder',
  'start-at-sign-in',
  'confirm-close',
  'away-minutes',
  'version',
  'whats-new',
  // Agents: adding an agent (the wizard lives in "Agent definitions")
  'definitions',
  // Agents: whether helpers an agent starts are shown, whether they stay open, and whether they close with their agent
  'helper-agents',
  'keep-helpers-open',
  'close-helpers-with-agent',
  // Keys: all of them
  'key-anthropic',
  'key-openai',
  'key-openrouter',
  'opencode-keys',
  'opencode-restart',
  'remove-all-keys',
  // Phone: pair a phone, and the phones that are paired
  'pairing',
  'paired-devices',
];

export const DEVELOPER_ROW_IDS: readonly string[] = [
  'bridge-endpoint',
  'mcp-status',
  'rust-mcp',
  'mcp-install',
  'snippet-claude-desktop',
  'snippet-codex',
  'settings-file',
  'diagnostic-file',
  'storage',
  'versions',
  'helper-tools',
];

export function levelOf(id: string): RowLevel {
  if (BASIC_ROW_IDS.includes(id)) return 'basic';
  if (DEVELOPER_ROW_IDS.includes(id)) return 'developer';
  return 'advanced';
}

const OPEN_KEY = (sectionId: string) => `pm-settings-advanced-open:${sectionId}`;

/** Whether a section's Advanced group was left open last time; null when never opened (the default). */
export function readAdvancedOpen(sectionId: string): boolean | null {
  try {
    const value = window.localStorage.getItem(OPEN_KEY(sectionId));
    return value === '1' ? true : value === '0' ? false : null;
  } catch {
    return null;
  }
}

/** Remember the Advanced group's state for one section. Storage may be blocked: then it is just not remembered. */
export function writeAdvancedOpen(sectionId: string, open: boolean): void {
  try {
    window.localStorage.setItem(OPEN_KEY(sectionId), open ? '1' : '0');
  } catch {
    /* not remembered */
  }
}
