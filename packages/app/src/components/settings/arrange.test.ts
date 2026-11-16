// How the eight pages are laid out: group titles, Advanced > Early features (Labs), the rules for all agents, and the catch-all.
import { describe, expect, it } from 'vitest';
import { ADVANCED_CLOSED_GROUPS, LABS_GROUP, LABS_INDEX_ID, LAYOUT, MOVED_TO_AGENT_PAGE, OTHER_GROUP, arrangeSections, collectLabs, layoutRowIds, unplacedRowIds } from './arrange';
import { BASE_SECTIONS, SECTIONS } from './catalog';
import { LABS_SWITCH_KEYS } from './labs-areas';
import { SECTION_IDS, groupRows, type BaseSectionDef, type RowDef } from './model';

const section = (id: string) => SECTIONS.find((s) => s.id === id)!;
const rowIn = (sectionId: string, rowId: string) => section(sectionId).rows.find((r) => r.id === rowId);
const baseRow = (id: string) => BASE_SECTIONS.flatMap((s) => s.rows).find((r) => r.id === id)!;

describe('the layout names real rows', () => {
  it('every id in LAYOUT is a row (or the Labs overview), and none is placed twice', () => {
    const real = new Set(BASE_SECTIONS.flatMap((s) => s.rows.map((r) => r.id)));
    real.add(LABS_INDEX_ID);
    const ids = layoutRowIds();
    for (const id of ids) expect(real.has(id), `LAYOUT names "${id}" which is not a row`).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('no row is left unplaced: nothing lands in Advanced > Other by accident', () => {
    expect(unplacedRowIds(BASE_SECTIONS)).toEqual([]);
    expect(SECTIONS.flatMap((s) => s.rows).filter((r) => r.group === OTHER_GROUP).map((r) => r.id)).toEqual([]);
  });

  it('arranging loses no row: a plain-switch early feature lives on the Labs page, and only the Labs overview is added', () => {
    const features = new Set(collectLabs(BASE_SECTIONS).filter((r) => LABS_SWITCH_KEYS[r.id]).map((r) => r.id));
    const before = BASE_SECTIONS.flatMap((s) => s.rows.map((r) => r.id))
      .filter((id) => !features.has(id) && !MOVED_TO_AGENT_PAGE.includes(id))
      .sort();
    const after = SECTIONS.flatMap((s) => s.rows)
      .filter((r) => r.id !== LABS_INDEX_ID)
      .map((r) => r.id)
      .sort();
    expect(after).toEqual(before);
  });

  it('keeps the seven pages, in order', () => {
    expect(SECTIONS.map((s) => s.id)).toEqual([...SECTION_IDS]);
    expect(Object.keys(LAYOUT).sort()).toEqual([...SECTION_IDS].sort());
  });

  it('does not touch a row: same hint and render function as its own definition (two labels are changed on purpose)', () => {
    const relabelled = new Set(['welcome']);
    for (const row of SECTIONS.flatMap((s) => s.rows).filter((r) => r.id !== LABS_INDEX_ID)) {
      const own = baseRow(row.id);
      if (!relabelled.has(row.id)) expect(row.label).toBe(own.label);
      expect(row.hint).toBe(own.hint);
      expect(row.render).toBe(own.render);
      expect(row.danger).toBe(own.danger);
    }
    expect(rowIn('overview', 'welcome')?.label).toBe('Run setup again');
    expect(rowIn('look', 'discord-alerts')?.group).toBe('While agents work');
  });
});

describe('groups inside the pages', () => {
  it('every row has a group title (a destructive row sits in the last list), and a title is not split in two', () => {
    for (const s of SECTIONS) {
      for (const row of s.rows.filter((r) => !r.danger)) expect(row.group, `${s.id}/${row.id}`).toBeTruthy();
      const heads = groupRows(s.rows)
        .filter((g) => !g.danger)
        .map((g) => g.head);
      expect(new Set(heads).size, `${s.id} repeats a group title: ${heads.join(', ')}`).toBe(heads.length);
    }
  });

  it('Look and feel reads: Appearance, Comfort, You, Startup, While agents work', () => {
    const heads = groupRows(section('look').rows).filter((g) => !g.danger).map((g) => g.head);
    expect(heads).toEqual(['Appearance', 'Comfort', 'You', 'Startup', 'While agents work']);
  });

  it('the Comfort rows sit on Look and feel', () => {
    for (const id of ['text-size', 'strong-contrast', 'less-motion', 'speak-results']) {
      expect(rowIn('look', id)?.group, id).toBe('Comfort');
    }
  });

  it('Overview reads: Setup, Updates', () => {
    expect(groupRows(section('overview').rows).map((g) => g.head)).toEqual(['Setup', 'Updates']);
  });

  it('the agent safety switches are in Agents > Rules for all agents', () => {
    for (const id of ['security-ask-before-control', 'security-agents-merge', 'security-recent-approvals']) {
      expect(rowIn('agents', id)?.group, id).toBe('Rules for all agents');
    }
  });

  it('Helpers starts with how helpers run; "Let agents ask each other" is a group with the agent pack', () => {
    expect(section('helpers').rows[0].id).toBe('started-agents');
    expect(rowIn('helpers', 'agent-pack')?.group).toBe('Let agents ask each other');
  });
});

describe('Advanced > Early features (Labs)', () => {
  const labsRows = () => section('labs').rows.filter((r) => r.group === LABS_GROUP);

  it('on the Labs page: the Labs index, then each feature that is more than a switch (its Open button lands there)', () => {
    expect(labsRows().map((r) => r.id)).toEqual([LABS_INDEX_ID, 'ask-bar', 'live-updates', 'opencode-automation', 'assign-issue', 'red-to-green']);
    expect(labsRows().filter((r) => LABS_SWITCH_KEYS[r.id])).toEqual([]);
    expect(collectLabs(BASE_SECTIONS).map((r) => r.id)).toEqual([
      'ask-bar', 'simple-mode', 'live-updates', 'opencode-automation', 'missions', 'assign-issue', 'night-shift',
      'red-to-green', 'spaces-labs', 'lend-labs', 'devices-labs', 'account-labs', 'desktop-potato-labs', 'agent-browser-labs', 'companion-vault-labs', 'discord-bot-labs', 'timeline-labs', 'project-guide-labs', 'markup-bar-labs', 'smaller-updates-labs', 'opentunnel-labs', 'crews-labs',
    ]);
    // They were defined in different files: Agents, Keys, Phone, General, Models.
    const homes = new Set(BASE_SECTIONS.filter((s) => s.rows.some((r) => r.labs)).map((s) => s.id));
    expect(homes.size).toBeGreaterThan(2);
    for (const page of SECTIONS.filter((s) => s.id !== 'advanced' && s.id !== 'labs')) expect(page.rows.some((r) => r.labs), page.id).toBe(false);
  });

  it('each feature has a short name and one plain line (no second sentence, no raw ids)', () => {
    const features = collectLabs(BASE_SECTIONS);
    for (const row of features) {
      const { name, about } = row.labs!;
      expect(name.length, row.id).toBeGreaterThan(2);
      expect(about, row.id).toMatch(/[.]$/);
      expect(about.split('. ').length, `${row.id}: one line`).toBe(1);
      expect(about.length, row.id).toBeLessThanOrEqual(90);
      expect(about, row.id).not.toMatch(/Hook Lane|hooks|_/);
    }
  });

  it('a feature another branch adds (a row with `labs`, in any section) is collected without touching this file', () => {
    const extra: RowDef = {
      id: 'later-feature',
      label: 'Missions',
      hint: 'Run an agent until a goal is met.',
      labs: { name: 'Missions', about: 'Run an agent until its checks pass.' },
      group: 'Missions',
      render: () => null,
    };
    const base: BaseSectionDef[] = BASE_SECTIONS.map((s) => (s.id === 'crews' ? { ...s, rows: [...s.rows, extra] } : s));
    const arranged = arrangeSections(base);
    expect(arranged.find((s) => s.id === 'labs')!.rows.filter((r) => r.group === LABS_GROUP).map((r) => r.id)).toEqual([LABS_INDEX_ID, 'ask-bar', 'live-updates', 'opencode-automation', 'assign-issue', 'red-to-green', 'later-feature']);
    const labs = collectLabs(base).map((r) => r.id);
    expect(labs.slice(-16)).toEqual(['red-to-green', 'spaces-labs', 'lend-labs', 'devices-labs', 'account-labs', 'desktop-potato-labs', 'agent-browser-labs', 'companion-vault-labs', 'discord-bot-labs', 'timeline-labs', 'project-guide-labs', 'markup-bar-labs', 'smaller-updates-labs', 'opentunnel-labs', 'crews-labs', 'later-feature']);
    expect(arranged.find((s) => s.id === 'look')!.rows.some((r) => r.id === 'later-feature')).toBe(false);
  });

  it('a row the layout does not name lands in Advanced > Other and is reported', () => {
    const extra: RowDef = { id: 'onboarding', label: 'Welcome tour', hint: 'Show the first-run tour again.', group: 'Welcome', render: () => null };
    const base: BaseSectionDef[] = BASE_SECTIONS.map((s) => (s.id === 'general' ? { ...s, rows: [...s.rows, extra] } : s));
    expect(unplacedRowIds(base)).toEqual(['onboarding']);
    const rows = arrangeSections(base).find((s) => s.id === 'advanced')!.rows;
    const last = rows[rows.length - 1];
    expect(last.id).toBe('onboarding');
    expect(last.group).toBe(OTHER_GROUP);
  });
});

describe('the Advanced page', () => {
  it('the Advanced page has four closed groups and no Advanced fold', () => {
    const advanced = section('advanced');
    // Four named groups; "Other" only shows when a row was left unplaced (it is empty now).
    expect(advanced.closedGroups).toEqual(ADVANCED_CLOSED_GROUPS);
    const withRows = ADVANCED_CLOSED_GROUPS.filter((g) => advanced.rows.some((r) => r.group === g));
    expect(withRows).toEqual(['Connections to other tools', 'Models', 'App and files']);
    // No other page has closed groups: they use the one "Advanced" fold.
    for (const s of SECTIONS.filter((x) => x.id !== 'advanced')) expect(s.closedGroups, s.id).toBeUndefined();
  });

  it('Developer and the danger list follow the closed groups', () => {
    const heads = groupRows(section('advanced').rows).map((g) => g.head);
    expect(heads.slice(-2)).toEqual(['Developer', undefined]);
    expect(section('advanced').rows.filter((r) => r.danger).map((r) => r.id)).toEqual(['uninstall', 'mcp-uninstall']);
  });
});
