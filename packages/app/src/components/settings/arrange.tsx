// Where every row lives, and in which group. The rows themselves stay in their section files (sections/*.tsx);
// this file is the one place that says how the eight pages are laid out for a person:
//   - the pages (title, blurb, order) and the group titles and their order inside each page
//   - which row sits on which page (the safety switches are under Agents > Rules for all agents, every early
//     feature is under Advanced > Early features (Labs), ...)
// A row that is not named here (for example one a new feature adds) lands in Advanced > Other, and the test in
// arrange.test.ts fails naming it, so nothing hides by accident.
import { SIGN_IN } from '../../lib/glossary';
import type { BaseSectionDef, RowDef, SectionDef, SectionId, SettingsEnv } from './model';
import { useDevLabsOverride, DEV_LABS_NOTE } from '../../lib/dev-labs';
import { t, type MessageKey } from '../../i18n';
import { Note, SettingBlock } from './settings-ui';

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

/** Early features list in this order; one added later (a new row with `labs`) is listed after them. */
const LABS_ORDER = ['ask-bar', 'simple-mode', 'live-updates', 'opencode-automation'];

/** The closed groups of the Advanced page, in order (Developer and the danger list follow them, open). */
export const ADVANCED_CLOSED_GROUPS = ['Connections to other tools', 'Models', LABS_GROUP, 'App and files', OTHER_GROUP];

export interface PageMeta {
  id: SectionId;
  title: string;
  blurb: string;
}

export const PAGES: PageMeta[] = [
  { id: 'overview', title: 'Overview', blurb: 'Is everything OK?' },
  { id: 'agents', title: 'Agents', blurb: 'Your agents, how they sign in and what they may do.' },
  { id: 'helpers', title: 'Helpers', blurb: 'When an agent asks another agent for help.' },
  { id: 'look', title: 'Look and feel', blurb: 'How the app looks and behaves.' },
  { id: 'connect', title: 'Connect', blurb: 'Your phone, your team and alerts.' },
  { id: 'keys', title: 'Keys', blurb: 'API keys. Kept in your system keychain when there is one.' },
  { id: 'shortcuts', title: 'Shortcuts', blurb: 'Click the keys to change them. Shortcuts work while Potato Workspace is in front, except those tagged Any app.' },
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
    { group: 'Where agents start', rows: ['project-folder', 'linux'] },
    { group: 'Moving work', rows: ['handoff-mode', 'keep-going'] },
    { group: 'All agents', rows: ['preload', 'agent-default-models', 'agent-lane', 'chat-addons', 'hidden-agents', 'versions'] },
    { group: 'Your chats', rows: ['bring-chats-agents'] },
    {
      group: 'Rules for all agents',
      rows: ['security-ask-before-control', 'security-agents-merge', 'loop-guard', 'package-check', 'collision', 'security-recent-approvals'],
    },
    { group: 'Limits', rows: ['budget-turns', 'budget-minutes'] },
    { group: 'Undo and memory', rows: ['checkpoints', 'checkpoints-keep', 'shared-memory'] },
    { group: 'Your own agents', rows: ['definitions'] },
  ],
  helpers: [
    { group: 'How helpers run', rows: ['helper-agents', 'helper-default-models', 'keep-helpers-open', 'close-helpers-with-agent'] },
    { group: 'Limits', rows: ['most-helpers-at-once'] },
    { group: 'Connect your agents', rows: ['agent-pack'] },
  ],
  look: [
    { group: 'Appearance', rows: ['theme', 'language', 'mode-switch-animation', 'individual-window-layout', 'usage-bar', 'usage-login-reads'] },
    { group: 'You', rows: ['your-name'] },
    { group: 'Startup', rows: ['start-at-sign-in'] },
    { group: 'While agents work', rows: ['confirm-close', 'keep-awake', 'away-minutes', 'quiet-hours'] },
  ],
  connect: [
    { group: 'Phone', rows: ['pairing', 'paired-devices', { row: 'phone-notifications', label: 'Phone alerts' }] },
    { group: 'Team', rows: ['team-page'] },
    { group: 'Lend', rows: ['lend-page'] },
    { group: 'Discord', rows: ['discord-alerts'] },
    { group: 'Share a chat', rows: ['live-room'] },
    { group: 'On the phone', rows: ['mobile-input-delay', 'mobile-keyboard-resizes', 'mobile-input-visible'] },
    { group: 'Public address', rows: ['tunnel'] },
    { group: 'Revoke', rows: ['revoke-all-devices'] },
  ],
  keys: [
    { group: 'Provider keys', rows: ['key-anthropic', 'key-openai', 'key-openrouter'] },
    { group: 'OpenCode keys', rows: ['opencode-keys', 'opencode-restart'] },
    { group: 'Remove keys', rows: ['remove-all-keys'] },
  ],
  // Shortcuts: one group per kind of shortcut, in the order lib/shortcuts.ts lists them (the section file names the groups).
  shortcuts: [{ group: 'Shortcuts', rows: ['@base:shortcuts'] }],
  advanced: [
    {
      group: 'Connections to other tools',
      rows: ['toolbelt', 'helper-tools', 'bridge-endpoint', 'mcp-status', 'rust-mcp', 'mcp-install', 'snippet-claude-desktop', 'snippet-codex'],
    },
    { group: 'Models', rows: ['librarian-indexer', 'opencode-provider', 'opencode-model', 'model-bridge'] },
    { group: LABS_GROUP, rows: [LABS_INDEX_ID, '@labs'] },
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

/** The translation of a Labs name or description, or the English from the row. */
function labsText(id: string, part: 'name' | 'about', english: string | undefined): string | undefined {
  const key = `labs.${id}.${part}`;
  const text = t(key as MessageKey);
  return text === key ? english : text;
}

function LabsIndex({ env, labs }: { env: SettingsEnv; labs: RowDef[] }) {
  const devLabs = useDevLabsOverride();
  return (
    <SettingBlock label={t('settings.row.labs-index.label')} description={t('settings.row.labs-index.hint')}>
      {devLabs && <Note>{DEV_LABS_NOTE}</Note>}
      <ul className="st-labs-list">
        {labs.map((row) => (
          <li key={row.id}>
            <button type="button" className="st-labs-item" onClick={() => env.openRow?.(row.id)}>
              <span className="st-labs-name">{labsText(row.id, 'name', row.labs?.name)}</span>
              <span className="st-labs-about">{labsText(row.id, 'about', row.labs?.about)}</span>
            </button>
          </li>
        ))}
      </ul>
    </SettingBlock>
  );
}

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
    level: 'advanced',
    label: 'Early features',
    hint: 'Tap one to jump to its switch.',
    keywords: 'labs early experimental preview beta features',
    render: (env) => <LabsIndex env={env} labs={labs} />,
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
    .filter((r) => !claimed.has(r.id) && !(collected && r.labs))
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
        if (entry === '@labs') {
          for (const row of labs) rows.push({ ...row, group: g.group, keywords: `${row.keywords ?? ''} labs early` });
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
