// The sections of Settings (seven) and the read-only "Coming later" list.
//
// `BASE_SECTIONS` is what each section file defines. `SECTIONS` is what the window shows: the same rows,
// placed and grouped by `arrange.tsx` (group titles, order, General > Labs, links where rows moved).
import { arrangeSections } from './arrange';
import { levelOf } from './levels';
import type { LaterItem, SectionDef } from './model';
import { agentsRows } from './sections/AgentsSection';
import { bridgeRows } from './sections/BridgeSection';
import { generalRows } from './sections/GeneralSection';
import { keysRows } from './sections/KeysSection';
import { modelBridgeRows } from './sections/ModelBridgeSection';
import { modelsRows } from './sections/ModelsSection';
import { phoneRows } from './sections/PhoneSection';
import { teamRows } from './sections/TeamSection';
import { lendRows } from './sections/LendSection';
import { shortcutsRows } from './sections/ShortcutsSection';

/** The sections as their files define them, with each row's level (levels.ts). */
const RAW_SECTIONS: SectionDef[] = [
  { id: 'general', title: 'General', blurb: 'Project, appearance, safety, early features and updates.', rows: generalRows },
  { id: 'agents', title: 'Agents', blurb: 'Sign in, keeping agents ready, versions and your own agents.', rows: agentsRows },
  { id: 'models', title: 'Orchestrator & Models', blurb: 'The project index, OpenCode defaults and Model Bridge.', rows: [...modelsRows, ...modelBridgeRows] },
  { id: 'keys', title: 'Keys', blurb: 'API keys. They are kept in your system keychain when there is one.', rows: keysRows },
  { id: 'bridge', title: 'Bridge & MCP', blurb: 'How other tools and agents connect to Potato Workspace.', rows: bridgeRows },
  { id: 'phone', title: 'Phone', blurb: 'Pair a phone to watch and steer your agents.', rows: phoneRows },
  { id: 'team', title: 'Team', blurb: 'Work with teammates: see when their agents push, and tell them about yours.', rows: teamRows },
  { id: 'lend', title: 'Lend', blurb: 'Lend an agent sign-in to another PC, or borrow one. Early feature.', rows: lendRows },
  { id: 'shortcuts', title: 'Shortcuts', blurb: 'Change the keys, or turn a shortcut off. Terminals keep their own keys.', rows: shortcutsRows },
];

export const BASE_SECTIONS: SectionDef[] = RAW_SECTIONS.map((section) => ({
  ...section,
  rows: section.rows.map((row) => ({ ...row, level: row.level ?? levelOf(row.id) })),
}));

export const SECTIONS: SectionDef[] = arrangeSections(BASE_SECTIONS);

/** Features that are planned but not built. Shown as plain text on the "Coming later" page, never as controls. */
export const LATER_ITEMS: LaterItem[] = [
  { title: 'Desktop notifications', note: 'Choose when Potato Workspace interrupts you on this computer.' },
  { title: 'Rules and guardrails', note: 'Limits on what agents may do without asking.' },
  { title: 'Backup and sync', note: 'Keep settings and sessions on more than one computer.' },
  { title: 'Agent marketplace', note: 'Find and install agent definitions made by others.' },
  { title: 'Automation', note: 'Start agents on a schedule or when something happens.' },
  { title: 'Observability', note: 'Traces and logs of what your agents did.' },
];
