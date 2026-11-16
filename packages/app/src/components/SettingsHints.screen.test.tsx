// @vitest-environment jsdom
// Settings wording and greyed-out hints: every disabled control says why, next to it. Rendered through the real rows
// (the catalog) and the real panel, so a renamed label or a removed hint shows up here.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiscordAlertsApi, DiscordAlertsStatus } from '../lib/discordAlerts';
import { DiscordAlertsBlock } from './settings/blocks/DiscordAlerts';
import { SECTIONS } from './settings/catalog';
import { rowLevel, type RowDef } from './settings/model';
import { BASE_SETTINGS, mountRows, settle, type Mounted } from './settings/test-utils';
import { SettingsPanel, type SettingsApi } from './SettingsPanel';

vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

const rowById = (id: string): RowDef => {
  const row = SECTIONS.flatMap((s) => s.rows).find((r) => r.id === id);
  if (!row) throw new Error(`no row ${id}`);
  return row;
};

describe('a disabled control says why, next to it', () => {
  let m: Mounted | undefined;
  afterEach(async () => {
    await m?.unmount();
    m = undefined;
  });

  it('Connect for this project says to pick a project folder first, while there is none', async () => {
    m = await mountRows([rowById('mcp-install')], { projectPath: null });
    const button = [...m.host.querySelectorAll('button')].find((b) => b.textContent?.includes('Connect for this project'));
    expect(button?.disabled).toBe(true);
    expect(m.host.textContent).toContain('Pick a project folder first.');
  });

  it('the hint goes away once a project folder is set', async () => {
    m = await mountRows([rowById('mcp-install')], { projectPath: 'D:/work/app' });
    expect(m.host.textContent).not.toContain('Pick a project folder first.');
  });

  it('Discord Save says to paste a webhook link first, while the box is empty', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const off: DiscordAlertsStatus = { saved: false, tail: null, kinds: { needs_you: true, finished: false, failed: true }, active: false };
    const api = { status: async () => off, setUrl: async () => off, clear: async () => off, setKinds: async () => off, test: async () => ({ ok: true, message: '' }) } as unknown as DiscordAlertsApi;
    await act(async () => root.render(<DiscordAlertsBlock api={api} />));
    await settle(4);
    const save = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Save');
    expect(save?.disabled).toBe(true);
    expect(host.textContent).toContain('Paste a webhook link first.');
    await act(async () => root.unmount());
    host.remove();
  });
});

describe('wording on the real panel', () => {
  const api: SettingsApi = {
    load: async () => ({ ...BASE_SETTINGS }),
    patch: async () => ({ ...BASE_SETTINGS }),
    findBridgeUrl: async () => null,
    subscribe: () => () => {},
  };
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it('the search box says "Search", not a cut-off "Search settings"', async () => {
    await act(async () => root.render(<SettingsPanel open inline api={api} />));
    await settle(6);
    const input = host.querySelector('input[aria-label="Search settings"]') as HTMLInputElement;
    expect(input.placeholder).toBe('Search');
  });

  it('the renamed rows read in plain English', () => {
    const label = (id: string) => rowById(id).label;
    // 'Chat or terminal' is on each agent's own page now (SettingsAgentPage.screen.test.tsx).
    expect(label('away-minutes')).toBe('Tell me what happened while I was away');
    expect(label('bridge-endpoint')).toBe("This app's address");
    expect(label('librarian-indexer')).toBe('Search inside my project');
    expect(rowById('snippet-codex').hint).toBe('Copy this to set it up by hand.');
  });

  it('the helpers group is "Let agents ask each other", not a second "Connect" meaning', () => {
    const helpers = SECTIONS.find((s) => s.id === 'helpers')!;
    expect(helpers.rows.some((r) => r.group === 'Let agents ask each other')).toBe(true);
    expect(helpers.rows.some((r) => r.group === 'Connect your agents')).toBe(false);
  });

  it('no row label says "MCP" outside the developer rows', () => {
    const jargon = SECTIONS.flatMap((s) => s.rows).filter((r) => /\bMCP\b/.test(r.label) && rowLevel(r) !== 'developer');
    expect(jargon.map((r) => r.id)).toEqual([]);
  });

  it('no row offers a shell command to type (no "wsl --" text)', () => {
    const all = SECTIONS.flatMap((s) => s.rows).map((r) => `${r.label} ${r.hint ?? ''}`).join(' ');
    expect(all).not.toMatch(/wsl --/);
  });
});
