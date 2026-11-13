// Settings search over the real pages: labels with their "Page > Group" path, synonyms, page names, every level, Labs flags.
import { describe, expect, it } from 'vitest';
import { SECTIONS } from './catalog';
import { LABS_INDEX_ID } from './arrange';
import { visibleSections } from './model';
import { levelTag, rowPath, searchAll } from './search';

const allRows = SECTIONS.flatMap((s) => s.rows.map((row) => ({ page: s, row })));
const ids = (query: string, sections = SECTIONS) => searchAll(sections, query).hits.flatMap((h) => h.rows.map((r) => r.id));

describe('settings search', () => {
  it('every row id is found by its own label, under its new page, with the path "Page > Group"', () => {
    for (const { page, row } of allRows) {
      const found = searchAll(SECTIONS, row.label).hits.find((h) => h.section.id === page.id);
      expect(found?.rows.map((r) => r.id), `${row.id} by "${row.label}"`).toContain(row.id);
      expect(rowPath(page, row)).toBe(row.group ? `${page.title} > ${row.group}` : page.title);
    }
    const theme = allRows.find((r) => r.row.id === 'theme')!;
    expect(rowPath(theme.page, theme.row)).toBe('Look and feel > Appearance');
  });

  it('synonyms: "dark mode" finds theme, "login" finds accounts, "api key" finds the key rows', () => {
    expect(ids('dark mode')).toContain('theme');
    expect(ids('login')).toContain('accounts');
    expect(ids('log in')).toContain('accounts');
    expect(ids('api key')).toEqual(expect.arrayContaining(['key-anthropic', 'key-openai', 'key-openrouter']));
    expect(ids('subagent')).toContain('helper-agents');
    expect(ids('hotkey')).toContain('shortcuts-reset-all');
    expect(ids('wsl')).toContain('linux');
    expect(ids('delete')).toEqual(expect.arrayContaining(['uninstall', 'remove-all-keys', 'revoke-all-devices']));
  });

  it('each deleted Coming later word still returns a live row', () => {
    const expected: Record<string, string> = {
      notifications: 'discord-alerts',
      backup: 'checkpoints',
      marketplace: 'definitions',
      rules: 'loop-guard',
      automation: 'night-shift',
      observability: 'diagnostic-file',
    };
    for (const [word, id] of Object.entries(expected)) {
      const found = ids(word);
      expect(found.length, word).toBeGreaterThan(0);
      expect(found, word).toContain(id);
    }
  });

  it('a page name is a hit: "helpers" lists the Helpers page first', () => {
    const result = searchAll(SECTIONS, 'helpers');
    expect(result.names[0].page.id).toBe('helpers');
    expect(result.names[0].group).toBeUndefined();
    expect(searchAll(SECTIONS, 'look').names[0].page.id).toBe('look');
    expect(searchAll(SECTIONS, 'sign').names.some((n) => n.page.id === 'agents' && n.group === 'Sign in')).toBe(true);
  });

  it('advanced and developer rows are found and carry their tag', () => {
    const rows = searchAll(SECTIONS, 'bridge address').hits.flatMap((h) => h.rows);
    const endpoint = rows.find((r) => r.id === 'bridge-endpoint')!;
    expect(levelTag(endpoint)).toBe('Developer');
    const checkpoints = searchAll(SECTIONS, 'checkpoints').hits.flatMap((h) => h.rows).find((r) => r.id === 'checkpoints')!;
    expect(levelTag(checkpoints)).toBe('Advanced');
    const theme = allRows.find((r) => r.row.id === 'theme')!.row;
    expect(levelTag(theme)).toBeNull();
  });

  it('a row hidden by a Labs flag is not listed, and its Labs switch is', () => {
    const off = visibleSections(SECTIONS, { acp_chat_enabled: false, model_bridge_enabled: false, lend_enabled: false });
    expect(ids('lend an agent', off)).not.toContain('lend-page');
    expect(ids('lend', off)).toContain('lend-labs');
    expect(ids('model bridge', off)).not.toContain('model-bridge');
    expect(ids('model bridge', off)).toContain('model-bridge-labs');
    const on = visibleSections(SECTIONS, { acp_chat_enabled: true, model_bridge_enabled: true, lend_enabled: true });
    expect(ids('lend an agent', on)).toContain('lend-page');
    expect(ids('labs', off)).toContain(LABS_INDEX_ID);
  });

  it('an unknown word shows the empty state with Clear search', async () => {
    const result = searchAll(SECTIONS, 'zzzqqq');
    expect(result.total).toBe(0);
    expect(result.names).toEqual([]);
    // The drawn state is covered at screen level (components/SettingsPanel.test.tsx).
    expect(searchAll(SECTIONS, '   ').total).toBe(0);
  });
});
