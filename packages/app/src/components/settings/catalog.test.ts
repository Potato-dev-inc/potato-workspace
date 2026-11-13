// The pages hold every live control of the old Settings, once, under unique ids, on the page and group the 2026-11-13 spec names.
import { describe, expect, it } from 'vitest';
import { BASE_SECTIONS, SECTIONS } from './catalog';
import { SECTION_IDS, groupRows, rowLevel, rowMatches, rowScore, searchSections } from './model';

const allRows = SECTIONS.flatMap((s) => s.rows.map((r) => ({ section: s.id, row: r })));

/** Every row id that existed before the move (115 of them, plus Add an agent and Your agents). */
const PINNED_IDS = [
  'accounts', 'acp-chat-labs', 'add-agent', 'agent-default-models', 'agent-lane', 'agent-list', 'agent-pack', 'ask-bar', 'assign-issue', 'away-minutes',
  'bridge-endpoint', 'bring-chats-agents', 'bring-old-chats', 'budget-minutes', 'budget-turns', 'chat-addons', 'chat-search-index',
  'checkpoints', 'checkpoints-keep', 'close-helpers-with-agent', 'collision', 'confirm-close', 'definitions', 'diagnostic-file',
  'discord-alerts', 'early-versions', 'handoff-mode', 'helper-agents', 'helper-default-models', 'helper-tools', 'hidden-agents',
  'individual-window-layout', 'keep-awake', 'language', 'keep-going', 'keep-helpers-open', 'key-anthropic', 'key-openai', 'key-openrouter',
  'lend-labs', 'lend-page', 'librarian-indexer', 'linux', 'live-room', 'live-updates', 'loop-guard', 'mcp-install', 'mcp-status',
  'mcp-uninstall', 'missions', 'mobile-input-delay', 'mobile-input-visible', 'mobile-keyboard-resizes', 'mode-switch-animation',
  'model-bridge', 'model-bridge-labs', 'most-helpers-at-once', 'night-shift', 'opencode-automation', 'opencode-keys', 'opencode-model',
  'opencode-provider', 'opencode-restart', 'package-check', 'paired-devices', 'pairing', 'phone-notifications', 'preload',
  'project-folder', 'quiet-hours', 'red-to-green', 'remove-all-keys', 'revoke-all-devices', 'rust-mcp', 'security-agents-merge',
  'security-ask-before-control', 'security-recent-approvals', 'settings-file', 'settings-recovery', 'setup-check', 'shared-memory',
  'shortcut-ask-aside', 'shortcut-ask-bar', 'shortcut-focus-mode', 'shortcut-mode-toggle', 'shortcut-new-agent', 'shortcut-next-needs-me', 'shortcut-open-inbox',
  'shortcut-palette', 'shortcut-pane-jump', 'shortcut-pane-next', 'shortcut-pane-prev', 'shortcut-remember', 'shortcut-search-chats',
  'shortcut-show-list', 'shortcut-split', 'shortcut-split-focus-left', 'shortcut-split-focus-right', 'shortcut-split-swap', 'shortcut-stop-all',
  'shortcuts-reset-all', 'show-developer-settings', 'simple-mode', 'snippet-claude-desktop', 'snippet-codex', 'spaces-labs',
  'start-at-sign-in', 'storage', 'team-page', 'telegram', 'theme', 'toolbelt', 'tunnel', 'uninstall', 'usage-bar', 'usage-login-reads',
  'version', 'versions', 'welcome', 'whats-new', 'your-name',
];

/** Spec section 2, as [page, group, row ids]. Shortcut rows keep the groups lib/shortcuts.ts gives them. */
const PLACEMENT: [string, string, string[]][] = [
  ['overview', 'Setup', ['setup-check', 'welcome']],
  ['overview', 'Updates', ['version', 'whats-new']],
  ['agents', 'Add an agent', ['add-agent']],
  ['agents', 'Your agents', ['agent-list']],
  ['agents', 'Sign in', ['accounts']],
  ['agents', 'Where agents start', ['project-folder', 'linux']],
  ['agents', 'Moving work', ['handoff-mode', 'keep-going']],
  ['agents', 'All agents', ['preload', 'agent-default-models', 'agent-lane', 'chat-addons', 'hidden-agents', 'versions']],
  ['agents', 'Your chats', ['bring-chats-agents']],
  ['agents', 'Rules for all agents', ['loop-guard', 'package-check', 'security-ask-before-control', 'security-agents-merge', 'security-recent-approvals', 'collision']],
  ['agents', 'Limits', ['budget-turns', 'budget-minutes']],
  ['agents', 'Undo and memory', ['checkpoints', 'checkpoints-keep', 'shared-memory']],
  ['agents', 'Your own agents', ['definitions']],
  ['helpers', 'How helpers run', ['helper-agents', 'keep-helpers-open', 'close-helpers-with-agent', 'helper-default-models']],
  ['helpers', 'Limits', ['most-helpers-at-once']],
  ['helpers', 'Connect your agents', ['agent-pack']],
  ['look', 'Appearance', ['theme', 'mode-switch-animation', 'individual-window-layout', 'usage-bar', 'usage-login-reads']],
  ['look', 'You', ['your-name']],
  ['look', 'Startup', ['start-at-sign-in']],
  ['look', 'While agents work', ['confirm-close', 'keep-awake', 'away-minutes', 'quiet-hours']],
  ['connect', 'Phone', ['pairing', 'paired-devices', 'phone-notifications']],
  ['connect', 'Team', ['team-page']],
  ['connect', 'Lend', ['lend-page']],
  ['connect', 'Discord', ['discord-alerts']],
  ['connect', 'Share a chat', ['live-room']],
  ['connect', 'On the phone', ['mobile-input-delay', 'mobile-keyboard-resizes', 'mobile-input-visible']],
  ['connect', 'Public address', ['tunnel']],
  ['keys', 'Provider keys', ['key-anthropic', 'key-openai', 'key-openrouter']],
  ['keys', 'OpenCode keys', ['opencode-keys', 'opencode-restart']],
  ['advanced', 'Connections to other tools', ['toolbelt', 'helper-tools', 'bridge-endpoint', 'mcp-status', 'rust-mcp', 'mcp-install', 'snippet-claude-desktop', 'snippet-codex']],
  ['advanced', 'Models', ['librarian-indexer', 'opencode-provider', 'opencode-model', 'model-bridge']],
  [
    'advanced',
    'Early features (Labs)',
    ['labs-index', 'simple-mode', 'ask-bar', 'live-updates', 'opencode-automation', 'missions', 'assign-issue', 'night-shift', 'red-to-green', 'acp-chat-labs', 'model-bridge-labs', 'spaces-labs', 'lend-labs', 'telegram'],
  ],
  ['advanced', 'App and files', ['storage', 'settings-file', 'diagnostic-file', 'chat-search-index', 'early-versions', 'settings-recovery', 'bring-old-chats']],
  ['advanced', 'Developer', ['show-developer-settings']],
];
/** Danger rows sit in the last list of their page (their group name is not shown). */
const DANGER: [string, string[]][] = [
  ['keys', ['remove-all-keys']],
  ['connect', ['revoke-all-devices']],
  ['advanced', ['uninstall', 'mcp-uninstall']],
];

describe('settings catalog', () => {
  it('has exactly the eight pages, in order: Overview, Agents, Helpers, Look and feel, Connect, Keys, Shortcuts, Advanced', () => {
    expect(SECTIONS.map((s) => s.id)).toEqual([...SECTION_IDS]);
    expect(SECTIONS.map((s) => s.title)).toEqual(['Overview', 'Agents', 'Helpers', 'Look and feel', 'Connect', 'Keys', 'Shortcuts', 'Advanced']);
  });

  it('every row id that existed before the move still exists exactly once', () => {
    const ids = allRows.map((r) => r.row.id).filter((id) => id !== 'labs-index');
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...PINNED_IDS].sort());
    expect(BASE_SECTIONS.flatMap((s) => s.rows).map((r) => r.id).sort()).toEqual([...PINNED_IDS].sort());
  });

  it('every row sits on the page and group the spec names', () => {
    const where = new Map(allRows.map(({ section, row }) => [row.id, { section, group: row.group }]));
    for (const [page, group, ids] of PLACEMENT) {
      for (const id of ids) expect(where.get(id), `${id} should be in ${page} > ${group}`).toEqual({ section: page, group });
    }
    for (const [page, ids] of DANGER) for (const id of ids) expect(where.get(id)?.section, id).toBe(page);
    // Every shortcut row is on the Shortcuts page.
    for (const { section, row } of allRows) if (row.id.startsWith('shortcut')) expect(section, row.id).toBe('shortcuts');
  });

  it('every row has a unique id, a label and a hint', () => {
    const ids = allRows.map((r) => r.row.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const { section, row } of allRows) {
      expect(row.label.trim(), `${section}/${row.id} label`).not.toBe('');
      expect(row.hint?.trim(), `${section}/${row.id} hint`).toBeTruthy();
    }
  });

  it('every visible hint is at most 90 characters (one line)', () => {
    const long = allRows.filter(({ row }) => (row.hint ?? '').length > 90).map(({ section, row }) => `${section}/${row.id}: ${row.hint?.length}`);
    expect(long).toEqual([]);
  });

  it('no page shows more than 10 basic rows', () => {
    for (const section of SECTIONS) {
      expect(section.rows.filter((r) => rowLevel(r) === 'basic').length, section.id).toBeLessThanOrEqual(10);
    }
  });

  it('no developer row sits outside the Advanced page', () => {
    // "Agent versions" stays a developer row in Agents > All agents until the agent page shows one version per agent (W2).
    const allowed = new Set(['versions']);
    const outside = allRows.filter(({ section, row }) => section !== 'advanced' && rowLevel(row) === 'developer' && !allowed.has(row.id)).map((r) => `${r.section}/${r.row.id}`);
    expect(outside).toEqual([]);
  });

  it('the Coming later page and its items are gone', () => {
    expect(SECTIONS.map((s) => s.id as string)).not.toContain('later');
    expect(SECTIONS.map((s) => s.title)).not.toContain('Coming later');
    for (const { row } of allRows) expect(`${row.label} ${row.hint}`, row.id).not.toMatch(/not available yet|coming later/i);
  });

  it('every page has rows, and destructive rows are only ever in the last group of their page', () => {
    for (const section of SECTIONS) {
      expect(section.rows.length, section.id).toBeGreaterThan(0);
      const groups = groupRows(section.rows);
      groups.slice(0, -1).forEach((g) => expect(g.danger, `${section.id} danger group not last`).toBe(false));
    }
  });

  it('destructive rows are only ever in the last group of their page', () => {
    for (const section of SECTIONS) {
      const groups = groupRows(section.rows);
      const dangerIndex = groups.findIndex((g) => g.danger);
      if (dangerIndex >= 0) expect(dangerIndex, section.id).toBe(groups.length - 1);
    }
  });

  it('keeps no planned or placeholder wording in any label or hint', () => {
    for (const { row } of allRows) {
      expect(`${row.label} ${row.hint}`, row.id).not.toMatch(/planned|not implemented|coming soon/i);
    }
  });

  it('the destructive rows are the ones the brief names', () => {
    const danger = allRows.filter((r) => r.row.danger).map((r) => `${r.section}/${r.row.id}`);
    expect(danger.sort()).toEqual(['advanced/mcp-uninstall', 'advanced/uninstall', 'connect/revoke-all-devices', 'keys/remove-all-keys']);
  });
});

describe('what a new person sees first in Agents', () => {
  const agents = SECTIONS.find((s) => s.id === 'agents')!;
  const level = (id: string) => agents.rows.find((r) => r.id === id)?.level;

  it('sign in is basic; Check my setup moved to Overview; your own agent files are advanced', () => {
    expect(level('accounts')).toBe('basic');
    expect(SECTIONS.find((s) => s.id === 'overview')!.rows.find((r) => r.id === 'setup-check')?.level).toBe('basic');
    expect(level('definitions')).toBe('advanced');
  });

  it('the sign-in row uses the shared words, not login or account', () => {
    const row = agents.rows.find((r) => r.id === 'accounts')!;
    expect(`${row.label} ${row.hint}`).not.toMatch(/login|account/i);
  });
});

describe('row search over the real catalog', () => {
  it('finds a row by a word in its label, hint or keywords, grouped under its page (best page first, nav order for ties)', () => {
    const hits = searchSections(SECTIONS, 'key');
    expect(hits.map((h) => h.section.id)).toEqual(expect.arrayContaining(['keys', 'connect']));
    // The Keys page holds the label hits, so it comes first even though Connect is earlier in the nav.
    expect(hits[0].section.id).toBe('keys');
  });

  it.each([
    ['checkpoints', 'checkpoints'],
    ['librarian', 'librarian-indexer'],
    ['toolbelt', 'toolbelt'],
    ['qr', 'pairing'],
    ['uninstall', 'uninstall'],
    ['idle timeout', 'preload'],
    ['tunnel', 'tunnel'],
    ['loop', 'loop-guard'],
    ['discord', 'discord-alerts'],
    ['away', 'away-minutes'],
  ])('"%s" finds the %s row', (query, id) => {
    const ids = SECTIONS.flatMap((s) => s.rows.filter((r) => rowMatches(r, query)).map((r) => r.id));
    expect(ids).toContain(id);
  });
});

describe('search ranking and coverage', () => {
  const rows = SECTIONS.flatMap((s) => s.rows).filter((r) => !r.pointer);
  const find = (id: string) => rows.find((r) => r.id === id)!;

  it('a hint only matches a whole word: "key" no longer finds "keyboard"', () => {
    expect(rowMatches(find('away-minutes'), 'key')).toBe(false);
    expect(rowMatches(find('away-minutes'), 'keyboard')).toBe(true);
    // the Settings file hint says "keys removed": that is not a row about keys
    expect(rowMatches(find('settings-file'), 'key')).toBe(false);
  });

  it('a label match outranks a keyword match, and a keyword match outranks a hint match', () => {
    const make = (over: Partial<(typeof rows)[number]>) => ({ id: 'x', label: 'Colours', hint: '', keywords: '', render: () => null, ...over });
    const label = make({ label: 'Anthropic API key' });
    const wordStart = make({ label: 'Keychain access' }); // starts with "key" but is not the word
    const keyword = make({ keywords: 'key secret' });
    const hint = make({ hint: 'Choose the key colour.' });
    expect(rowScore(label, 'key')).toBeGreaterThan(rowScore(wordStart, 'key'));
    expect(rowScore(wordStart, 'key')).toBeGreaterThan(rowScore(keyword, 'key'));
    expect(rowScore(keyword, 'key')).toBeGreaterThan(rowScore(hint, 'key'));
    expect(rowScore(hint, 'key')).toBe(1);
    expect(rowScore(make({}), 'key')).toBe(0);
  });

  it('results list the best group of a page first, and keep a group together', () => {
    for (const hit of searchSections(SECTIONS, 'key')) {
      const seen: (string | undefined)[] = [];
      for (const row of hit.rows) if (seen[seen.length - 1] !== row.group) seen.push(row.group);
      expect(new Set(seen).size, `${hit.section.id} groups interleave`).toBe(seen.length);
    }
    const keys = searchSections(SECTIONS, 'key').find((h) => h.section.id === 'keys')!;
    expect(keys.rows[0].group).toBe('Provider keys');
  });

  it('every row is found by its own label, and by every whole word of its hint', () => {
    for (const row of rows) {
      expect(rowMatches(row, row.label), `${row.id} by label`).toBe(true);
      for (const word of (row.hint ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)) {
        expect(rowMatches(row, word), `${row.id} by hint word "${word}"`).toBe(true);
      }
    }
  });

  it('plural and singular both find a row: "keys" finds the API key rows', () => {
    expect(rowMatches(find('key-openai'), 'keys')).toBe(true);
    expect(rowMatches(find('key-openai'), 'openai key')).toBe(true);
  });

  it('a link left where a row moved is never a search hit (the real row is)', () => {
    const everything = searchSections(SECTIONS, 'live updates').flatMap((h) => h.rows);
    expect(everything.filter((r) => r.id === 'live-updates')).toHaveLength(1);
    expect(everything.some((r) => r.pointer)).toBe(false);
  });

  it('Labs: "labs", "early" and each feature name find the right row', () => {
    const hit = (q: string) => searchSections(SECTIONS, q).flatMap((h) => h.rows.map((r) => r.id));
    expect(hit('labs')).toEqual(expect.arrayContaining(['labs-index', 'ask-bar', 'simple-mode', 'live-updates', 'opencode-automation']));
    expect(hit('hook lane')).toContain('live-updates');
    expect(hit('simple')).toContain('simple-mode');
  });
});

describe('plain words in labels and hints', () => {
  const rows = SECTIONS.flatMap((s) => s.rows);
  const banned = /TOML|vendor\/model|\.md|\.py|hooks?|Hook Lane|worktree|PWA|_[a-z]+|[a-z]+_[a-z]+/;
  it('no raw ids, file names or snake_case on the page, and not the word "Hook Lane"', () => {
    // HANDOFF.md is the one file name a person is told about (Quick handoff saves it).
    for (const row of rows) expect(`${row.label} ${row.hint}`.replace('HANDOFF.md', 'the handoff file'), row.id).not.toMatch(banned);
  });
  it('every row has a hint, and a hint is one or two short sentences', () => {
    for (const row of rows) {
      expect(row.hint, row.id).toBeTruthy();
      expect((row.hint ?? '').length, `${row.id} hint length`).toBeLessThanOrEqual(260);
    }
  });
});
