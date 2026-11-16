// The pages of Settings (eight).
//
// `BASE_SECTIONS` is what each section file defines. `SECTIONS` is what the window shows: the same rows,
// placed and grouped by `arrange.tsx` (pages, group titles, order, Advanced > Early features (Labs)).
import { arrangeSections } from './arrange';
import { levelOf } from './levels';
import { withRowMeta } from './row-meta';
import type { BaseSectionDef, SectionDef } from './model';
import { agentsRows } from './sections/AgentsSection';
import { bridgeRows } from './sections/BridgeSection';
import { generalRows } from './sections/GeneralSection';
import { keysRows } from './sections/KeysSection';
import { modelBridgeRows } from './sections/ModelBridgeSection';
import { modelsRows } from './sections/ModelsSection';
import { crewsRows } from './sections/CrewsSection';
import { shortcutsRows } from './sections/ShortcutsSection';

/** The sections as their files define them, with each row's level (levels.ts). */
const RAW_SECTIONS: BaseSectionDef[] = [
  { id: 'general', title: 'General', blurb: 'Project, appearance, safety, early features and updates.', rows: generalRows },
  { id: 'agents', title: 'Agents', blurb: 'Sign in, keeping agents ready, versions and your own agents.', rows: agentsRows },
  { id: 'models', title: 'Orchestrator & Models', blurb: 'The project index, OpenCode defaults and Model Bridge.', rows: [...modelsRows, ...modelBridgeRows] },
  { id: 'keys', title: 'Keys', blurb: 'API keys. They are kept in your system keychain when there is one.', rows: keysRows },
  { id: 'bridge', title: 'Bridge & MCP', blurb: 'How other tools and agents connect to Potato Workspace.', rows: bridgeRows },
  { id: 'crews', title: 'Crews', blurb: 'Crews of agents, shown as boxes. Early feature.', rows: crewsRows },
  { id: 'shortcuts', title: 'Shortcuts', blurb: 'Change the keys, or turn a shortcut off. Terminals keep their own keys.', rows: shortcutsRows },
];

export const BASE_SECTIONS: BaseSectionDef[] = RAW_SECTIONS.map((section) => ({
  ...section,
  rows: withRowMeta(section.rows.map((row) => ({ ...row, level: row.level ?? levelOf(row.id) }))),
}));

export const SECTIONS: SectionDef[] = arrangeSections(BASE_SECTIONS);
