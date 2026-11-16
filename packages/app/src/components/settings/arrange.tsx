// Where every row lives, and in which group. The rows themselves stay in their section files (sections/*.tsx);
// this file is the one place that says how the eight pages are laid out for a person:
//   - the pages (title, blurb, order) and the group titles and their order inside each page
//   - which row sits on which page (the safety switches are under Agents > Rules for all agents, every early
//     feature is under Advanced > Early features (Labs), ...)
// A row that is not named here (for example one a new feature adds) lands in Advanced > Other, and the test in
// arrange.test.ts fails naming it, so nothing hides by accident.
import { SIGN_IN } from '../../lib/glossary';
import type { BaseSectionDef, RowDef, SectionDef, SectionId } from './model';
import { LabsPage } from './LabsPage';
import { LABS_SWITCH_KEYS } from './labs-areas';
import { t } from '../../i18n';

/**
 * One entry of a group: a row id, a row with its label changed here (`row`), `@labs` (every early feature), or
 * `@base:<section>` (every row of that section file that is not named elsewhere, each keeping its own group).
 */
export type LayoutEntry = string | { row: string; label?: string };

export interface LayoutGroup {
  group: string;
  rows: LayoutEntry[];
}

export const LABS_GROUP = 'Early features (Labs)';
/** Row id of the Labs overview (a deep link to Advanced > Early features (Labs)). */
export const LABS_INDEX_ID = 'labs-index';
/** The group that catches a row nobody placed. */
export const OTHER_GROUP = 'Other';

/**
 * Rows that now live on each agent's own page (Settings > Agents > <agent>) and are no longer listed on the Agents page.
 * Their definitions stay (deep links, the agent page blocks); a link to one opens the agent list (see settings-target.ts).
 */
export const MOVED_TO_AGENT_PAGE: readonly string[] = ['agent-default-models', 'agent-lane', 'chat-addons'];

/** Early features list in this order; one added later (a new row with `labs`) is listed after them. */
const LABS_ORDER = ['ask-bar', 'simple-mode', 'live-updates', 'opencode-automation'];

/** The closed groups of the Advanced page, in order (Developer and the danger list follow them, open). */
export const ADVANCED_CLOSED_GROUPS = ['Connections to other tools', 'Models', 'App and files', OTHER_GROUP];

export interface PageMeta {
  id: SectionId;
  title: string;
  blurb: string;
}

export const PAGES: PageMeta[] = [
  { id: 'overview', title: 'Overview', blurb: 'Is everything OK?' },
  { id: 'agents', title: 'Agents', blurb: 'Your agents, how they sign in and what they may do.' },
  { id: 'helpers', title: 'Agents that agents start', blurb: 'When an agent starts another agent.' },
  { id: 'look', title: 'Look and feel', blurb: 'How the app looks and behaves.' },
  { id: 'keys', title: 'Keys', blurb: 'API keys. Kept in your system keychain when there is one.' },
  { id: 'shortcuts', title: 'Shortcuts', blurb: 'Click the keys to change them. Shortcuts work while Potato Workspace is in front, except those tagged Any app.' },
  { id: 'labs', title: 'Labs', blurb: 'Early features. Off by default; turn one on to try it, and read what it does.' },
  { id: 'advanced', title: 'Advanced', blurb: 'For developers and the curious. Most people never need this page.' },
];

export const LAYOUT: Record<SectionId, LayoutGroup[]> = {
  overview: [
    { group: 'Setup', rows: ['setup-check', { row: 'welcome', label: 'Run setup again' }] },
    { group: 'Updates', rows: ['version', 'whats-new'] },
  ],
  agents: [
    { group: 'Add an agent', rows: ['add-agent'] },
    { group: 'Your agents', rows: ['agent-list'] },
    { group: SIGN_IN.group, rows: ['accounts'] },
    { group: 'Where agents start', rows: ['project-folder', 'copy-offer', 'linux'] },
    { group: 'Moving work', rows: ['handoff-mode', 'keep-going'] },
    { group: 'All agents', rows: ['show-terminals', 'preload', 'versions'] },
    { group: 'Standby helpers', rows: ['standby-helpers', 'helper-answers'] },
    {
      group: 'Rules for all agents',
      rows: ['security-ask-before-control', 'security-agents-merge', 'agent-rules', 'loop-guard', 'package-check', 'collision', 'security-recent-approvals'],
    },
    { group: 'Limits', rows: ['budget-turns', 'project-budget', 'right-size'] },
    { group: 'Undo and memory', rows: ['checkpoints', 'shared-memory'] },
    { group: 'Your own agents', rows: ['definitions'] },
  ],
  helpers: [
    { group: 'How helpers run', rows: ['started-agents', 'helper-agents', 'helpers-in-sidebar', 'helper-default-models', 'keep-helpers-open', 'close-helpers-with-agent'] },
    { group: 'Limits', rows: ['most-helpers-at-once', 'stuck-helper-minutes'] },
    { group: 'Crews', rows: ['crews-page'] },
    { group: 'Let agents ask each other', rows: ['agent-pack'] },
  ],
  look: [
    { group: 'Appearance', rows: ['theme', 'language', 'mode-switch-animation', 'individual-window-layout', 'usage-bar', 'usage-login-reads'] },
    { group: 'Comfort', rows: ['text-size', 'strong-contrast', 'less-motion', 'speak-results'] },
    { group: 'You', rows: ['your-name'] },
    { group: 'Startup', rows: ['start-at-sign-in'] },
    { group: 'While agents work', rows: ['confirm-close', 'keep-awake', 'away-minutes', 'quiet-hours', 'pc-notifications', 'discord-alerts'] },
  ],
  keys: [
    { group: 'Provider keys', rows: ['key-anthropic', 'key-openai', 'key-openrouter'] },
    { group: 'OpenCode keys', rows: ['opencode-keys'] },
    { group: 'Remove keys', rows: ['remove-all-keys'] },
  ],
  // Shortcuts: one group per kind of shortcut, in the order lib/shortcuts.ts lists them (the section file names the groups).
  shortcuts: [{ group: 'Shortcuts', rows: ['@base:shortcuts'] }],
  // Labs: its own page in the nav. The index row draws every switch; features with more than a switch are listed under it.
  labs: [{ group: LABS_GROUP, rows: [LABS_INDEX_ID, '@labs'] }],
  advanced: [
    {
      group: 'Connections to other tools',
      rows: ['toolbelt', 'helper-tools', 'bridge-endpoint', 'mcp-status', 'rust-mcp', 'mcp-install', 'snippet-claude-desktop', 'snippet-codex'],
    },
    { group: 'Models', rows: ['librarian-indexer', 'opencode-provider', 'opencode-model', 'model-bridge'] },
    { group: 'App and files', rows: ['storage', 'settings-file', 'diagnostic-file', 'chat-search-index', 'early-versions', 'settings-recovery', 'bring-old-chats'] },
    { group: 'Developer', rows: ['show-developer-settings'] },
    { group: 'Uninstall', rows: ['uninstall', 'mcp-uninstall'] },
  ],
};

/** The row id an entry names (null for the `@labs` placeholder). */
function entryId(entry: LayoutEntry): string | null {
  if (typeof entry !== 'string') return entry.row;
  return entry.startsWith('@') ? null : entry;
}

/** Every row id the layout names (not the `@labs` placeholder). Used to catch stale ids. */
export function layoutRowIds(layout: Partial<Record<SectionId, LayoutGroup[]>> = LAYOUT): string[] {
  const ids: string[] = [];
  for (const groups of Object.values(layout)) {
    for (const g of groups ?? []) {
      for (const entry of g.rows) {
        const id = entryId(entry);
        if (id) ids.push(id);
      }
    }
  }
  return ids;
}

// ---------- the rows this file adds ----------

// ---------- arrange ----------

/** The early features of every section, in the order they are listed in Labs. */
export function collectLabs(sections: Pick<BaseSectionDef, 'rows'>[]): RowDef[] {
  const all = sections.flatMap((s) => s.rows).filter((r) => r.labs);
  const rank = (id: string) => {
    const i = LABS_ORDER.indexOf(id);
    return i < 0 ? LABS_ORDER.length : i;
  };
  return all.map((row, index) => ({ row, index })).sort((a, b) => rank(a.row.id) - rank(b.row.id) || a.index - b.index).map((x) => x.row);
}

function labsIndexRow(labs: RowDef[]): RowDef | null {
  if (labs.length === 0) return null;
  return {
    id: LABS_INDEX_ID,
    level: 'basic',
    label: 'Early features',
    hint: 'Turn each early feature on or off, and read what it does.',
    // A search for any early feature's name or words lands on this page, since the features are listed only here.
    keywords: ['labs early experimental preview beta features', ...labs.map((row) => `${row.label} ${row.keywords ?? ''}`)].join(' '),
    render: (env) => <LabsPage env={env} labs={labs} />,
  };
}

/** Ids of rows the layout does not place (and that are not early features, which `@labs` collects). Should be empty. */
export function unplacedRowIds(base: BaseSectionDef[], layout: Partial<Record<SectionId, LayoutGroup[]>> = LAYOUT): string[] {
  const claimed = new Set<string>(layoutRowIds(layout));
  const collected = layoutHasLabs(layout);
  const wholeSections = new Set(baseSectionsTaken(layout));
  return base
    .filter((s) => !wholeSections.has(s.id))
    .flatMap((s) => s.rows)
    .filter((r) => !claimed.has(r.id) && !MOVED_TO_AGENT_PAGE.includes(r.id) && !(collected && r.labs))
    .map((r) => r.id);
}

/** The section files a layout takes whole (`@base:<section>`). */
function baseSectionsTaken(layout: Partial<Record<SectionId, LayoutGroup[]>>): string[] {
  return Object.values(layout).flatMap((groups) => (groups ?? []).flatMap((g) => g.rows.filter((e): e is string => typeof e === 'string' && e.startsWith('@base:')).map((e) => e.slice(6))));
}

function layoutHasLabs(layout: Partial<Record<SectionId, LayoutGroup[]>>): boolean {
  return Object.values(layout).some((groups) => groups?.some((g) => g.rows.includes('@labs')));
}

/**
 * The pages as a person sees them. Pure: it returns new section objects and never changes the rows' own
 * definitions (their ids, hints and render functions), only where they sit, under which group, and (for the
 * few entries that say so) the label. A row nobody placed lands in Advanced > Other.
 */
export function arrangeSections(base: BaseSectionDef[], layout: Partial<Record<SectionId, LayoutGroup[]>> = LAYOUT): SectionDef[] {
  const byId = new Map<string, RowDef>();
  for (const section of base) for (const row of section.rows) byId.set(row.id, row);

  const labs = collectLabs(base);
  const labsIndex = labsIndexRow(labs);
  if (labsIndex) byId.set(labsIndex.id, labsIndex);

  const unplaced = unplacedRowIds(base, layout).map((id) => byId.get(id)).filter((r): r is RowDef => Boolean(r));

  return PAGES.map((page) => {
    const rows: RowDef[] = [];
    for (const g of layout[page.id] ?? []) {
      for (const entry of g.rows) {
        // A plain on/off early feature is not listed as a row: the Labs page (LABS_INDEX_ID) draws its switch.
        // One with more than a switch (Ask bar, Live updates, Telegram...) keeps its own row, which the Labs
        // page's Open button and a deep link jump to.
        if (entry === '@labs') {
          for (const row of labs) if (!LABS_SWITCH_KEYS[row.id]) rows.push({ ...row, group: g.group, keywords: `${row.keywords ?? ''} labs early`, ...(page.id === 'labs' ? { level: 'basic' as const } : {}) });
          continue;
        }
        if (typeof entry === 'string' && entry.startsWith('@base:')) {
          const claimed = new Set(layoutRowIds(layout));
          for (const row of base.find((s) => s.id === entry.slice(6))?.rows ?? []) if (!claimed.has(row.id)) rows.push(row);
          continue;
        }
        const id = entryId(entry);
        const found = id ? byId.get(id) : undefined;
        if (!found) continue;
        const label = typeof entry === 'string' ? undefined : entry.label;
        rows.push({ ...found, group: g.group, ...(label ? { label } : {}) });
      }
    }
    if (page.id === 'advanced') for (const row of unplaced) rows.push({ ...row, group: OTHER_GROUP });
    const closedGroups = page.id === 'advanced' ? ADVANCED_CLOSED_GROUPS : undefined;
    return { id: page.id, title: page.title, blurb: page.blurb, rows, ...(closedGroups ? { closedGroups } : {}) };
  });
}
