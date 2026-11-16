// @vitest-environment jsdom
// 1.1.8 "Templates and sharing", through the real Settings screen and the crew canvas: with no saved crew the page offers the ready-made
// crews as cards ("How we work" among them), one opens on the canvas, "Share" writes the crew as one file, and "Open a shared crew" shows
// what a file would set up before anything changes. Nothing is saved or started until the person saves, and a crew with problems cannot
// be saved. Only the desktop commands and the file dialogs are faked.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsPanel, type SettingsApi } from '../SettingsPanel';
import { BASE_SETTINGS, click, settle, type } from '../settings/test-utils';

const role = (id: string, name: string, parent?: string, extra: Record<string, unknown> = {}) => ({ id, name, agent_type: '{default}', task: `${name} job in {folder}.`, ...(parent ? { parent } : {}), ...extra });
const how = {
  name: 'How we work',
  routing_file: 'how-we-work.md',
  roles: [
    role('lead', 'Lead', undefined, { permissions: { read: true, write: 'none', run: 'ask', start_helpers: true, merge: true }, hands_to: ['scout'] }),
    role('scout', 'Scout', 'lead'),
    role('worker-easy', 'Worker (easy)', 'lead'),
    role('worker-medium', 'Worker (medium)', 'lead'),
    role('worker-hard', 'Worker (hard)', 'lead'),
    role('checker', 'Checker', 'lead', { check: true }),
  ],
};
const HOW_RULES = 'Easy -> worker-easy\n- Small changes.\n';
const summary = (slug: string, name: string, roles: number) => ({ slug, name, roles, agents: ['{default}'], problem: null });
const shared = {
  crew: { name: 'Teammate crew', roles: [role('lead', 'Boss', undefined, { permissions: { read: true, write: 'none', run: 'worktree', start_helpers: true, merge: true }, standbys: 1 }), role('helper', 'Helper', 'lead')] },
  routing_text: 'Always ask me before you merge.\n',
  problems: [] as Array<{ code: string; role: string | null; message: string }>,
  may_merge: ['Boss'],
  may_start_helpers: ['Boss'],
  runs_commands: ['Boss'],
  standbys: 1,
};

let calls: Array<{ command: string; args: Record<string, unknown> | undefined }> = [];
let saved: ReturnType<typeof summary>[] = [];
let dialogSave: string | null = null;
let dialogOpen: string | null = null;
let preview = shared;
vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: vi.fn(async () => dialogSave),
  open: vi.fn(async () => dialogOpen),
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    switch (command) {
      case 'crews_list':
        return saved;
      case 'crews_templates':
        return [summary('template:our-way', 'Our way', 7), summary('template:how-we-work', 'How we work', 6)];
      case 'crews_starters':
        return [summary('starter:builder-reviewer', 'Builder + Reviewer', 2)];
      case 'crews_agents':
        return { agents: [{ id: 'claude', label: 'Claude' }], default: 'claude' };
      case 'crews_open': {
        const slug = String(args?.slug);
        if (slug === 'template:how-we-work') return { slug, kind: 'template', crew: how, routing_text: HOW_RULES, problems: [] };
        if (slug === 'teammate-crew') return { slug, kind: 'saved', crew: shared.crew, routing_text: shared.routing_text, problems: [] };
        return { slug, kind: 'template', crew: { ...how, name: 'Other' }, routing_text: '', problems: [] };
      }
      case 'crews_export_file':
        return args?.target;
      case 'crews_import_read':
        return preview;
      case 'crews_check':
        return [];
      case 'crews_save_canvas':
        saved = [summary('teammate-crew', String((args?.crew as { name: string }).name), 2)];
        return { slug: 'teammate-crew', errors: [] };
      default:
        throw new Error(`not answered in this test: ${command}`);
    }
  }),
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

let host: HTMLDivElement;
let root: Root;
const api: SettingsApi = {
  load: async () => ({ ...BASE_SETTINGS, crews_enabled: true }),
  patch: async () => ({ ...BASE_SETTINGS, crews_enabled: true }),
  findBridgeUrl: async () => null,
  subscribe: () => () => {},
};

beforeEach(async () => {
  calls = [];
  saved = [];
  dialogSave = 'C:/share/how-we-work.crew.json';
  dialogOpen = 'C:/share/teammate.crew.json';
  preview = shared;
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(<SettingsPanel open api={api} initialTab="helpers" initialRow="crews-page" />));
  for (let i = 0; i < 100 && !host.querySelector('.crews-page'); i++) await act(async () => new Promise((r) => setTimeout(r, 50)));
  await settle(10);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

const text = () => document.body.textContent ?? '';
const button = (label: string) => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
const boxes = () => [...document.querySelectorAll<HTMLElement>('[data-testid="crew-box"]')];
const cards = () => [...document.querySelectorAll<HTMLElement>('[data-testid="crew-card"]')];
const risky = ['crews_start', 'crews_apply', 'crews_save_canvas', 'crews_save', 'crews_remove'];
const ran = (names: string[]) => calls.filter((c) => names.includes(c.command));

describe('templates and sharing, through the Settings screen and the crew canvas', () => {
  it('offers the ready-made crews as cards on an empty page, including How we work', async () => {
    expect(document.querySelector('[data-testid="crew-gallery"]')).not.toBeNull();
    expect(cards().map((c) => c.querySelector('.crews-row-name')!.textContent)).toEqual(['Our way', 'How we work', 'Builder + Reviewer']);
    expect(text()).toContain('No crew of yours yet. Start from a ready-made one.');
    expect(cards()[1].textContent).toContain('A lead, a scout, three workers and a checker.');
    expect(cards()[1].textContent).toContain('6 roles');
  });

  it('opens How we work as six read-only boxes', async () => {
    await click(cards()[1].querySelector('button'));
    await settle(10);
    expect(boxes().map((b) => b.querySelector('.crewc-box-name')!.textContent)).toEqual(['Lead', 'Scout', 'Worker (easy)', 'Worker (medium)', 'Worker (hard)', 'Checker']);
    expect(boxes()[0].textContent).toContain('Your default agent');
    expect(text()).not.toContain('{default}');
    expect(text()).toContain('This is a ready-made crew.');
    expect(button('Save my own copy')).toBeDefined();
  });

  it('shares the crew as one file in the place the person picked', async () => {
    await click(cards()[1].querySelector('button'));
    await settle(10);
    await click(button('Share'));
    await settle(5);
    const call = calls.find((c) => c.command === 'crews_export_file')!;
    expect(call.args).toMatchObject({ routingText: HOW_RULES, target: 'C:/share/how-we-work.crew.json' });
    expect((call.args!.crew as { name: string }).name).toBe('How we work');
    expect(text()).toContain('Saved the file: C:/share/how-we-work.crew.json');
    expect(ran(risky)).toEqual([]);
  });

  it('does nothing when the person cancels the file dialog', async () => {
    dialogSave = null;
    await click(cards()[1].querySelector('button'));
    await settle(10);
    await click(button('Share'));
    await settle(5);
    expect(calls.find((c) => c.command === 'crews_export_file')).toBeUndefined();
    expect(text()).not.toContain('Saved the file');
  });

  it('shows what a shared file would set up first, and saves only when asked', async () => {
    await click(button('Open a shared crew…'));
    await settle(10);
    expect(calls.find((c) => c.command === 'crews_import_read')!.args).toEqual({ source: 'C:/share/teammate.crew.json' });
    const sheet = document.querySelector('[data-testid="import-sheet"]')!;
    expect(sheet.textContent).toContain('This file holds a crew of 2 roles. Nothing has been saved or started.');
    expect(sheet.querySelector('[data-testid="import-facts"]')!.textContent).toContain('May merge work: Boss');
    expect(sheet.querySelector('[data-testid="import-facts"]')!.textContent).toContain('Runs commands in its own copy of the project: Boss');
    expect([...sheet.querySelectorAll('[data-testid="import-roles"] > li')].map((li) => li.querySelector('strong')!.textContent)).toEqual(['Boss', 'Helper']);
    expect(sheet.querySelector('[data-testid="import-rules"]')!.textContent).toContain('Always ask me before you merge.');
    expect(sheet.textContent).not.toContain('{default}');
    expect(text()).toContain('These rules came from someone else.');
    expect(ran(risky)).toEqual([]);

    await click(button('Save to my crews'));
    await settle(10);
    const save = calls.find((c) => c.command === 'crews_save_canvas')!;
    expect(save.args).toMatchObject({ replace: false, routingText: 'Always ask me before you merge.\n' });
    expect((save.args!.crew as { name: string }).name).toBe('Teammate crew');
    expect(document.querySelector('[data-testid="import-sheet"]')).toBeNull();
    expect(calls.map((c) => c.command)).not.toContain('crews_start');
    expect(calls.map((c) => c.command)).not.toContain('crews_apply');
    expect(document.querySelector('[data-testid="crew-canvas"]')).not.toBeNull();
  });

  it('lets the person rename a shared crew before saving it', async () => {
    await click(button('Open a shared crew…'));
    await settle(10);
    const name = document.querySelector<HTMLInputElement>('[data-testid="import-sheet"] input[type="text"]')!;
    await type(name, 'Our copy');
    await click(button('Save to my crews'));
    await settle(10);
    expect((calls.find((c) => c.command === 'crews_save_canvas')!.args!.crew as { name: string }).name).toBe('Our copy');
  });

  it('will not save a shared crew the crew check refuses', async () => {
    preview = { ...shared, problems: [{ code: 'CREW_AGENT_UNKNOWN', role: 'Boss', message: 'Boss uses an agent this app does not know.' }] };
    await click(button('Open a shared crew…'));
    await settle(10);
    expect(document.querySelector('[data-testid="import-problems"]')!.textContent).toContain('Boss uses an agent this app does not know.');
    expect(button('Save to my crews')!.disabled).toBe(true);
    await click(button('Save to my crews'));
    expect(ran(risky)).toEqual([]);
  });

  it('shows a plain message when the file is not a shared crew, and nothing when the dialog is cancelled', async () => {
    preview = null as never;
    const { invoke } = await import('@tauri-apps/api/core');
    (invoke as unknown as { mockImplementationOnce: (f: () => Promise<never>) => void }).mockImplementationOnce(() => Promise.reject(new Error('CREW_SHARE_INVALID: This is not a shared crew file.')));
    await click(button('Open a shared crew…'));
    await settle(10);
    expect(text()).toContain('This is not a shared crew file.');
    expect(document.querySelector('[data-testid="import-sheet"]')).toBeNull();

    dialogOpen = null;
    calls = [];
    await click(button('Open a shared crew…'));
    await settle(10);
    expect(calls.find((c) => c.command === 'crews_import_read')).toBeUndefined();
    expect(document.querySelector('[data-testid="import-sheet"]')).toBeNull();
  });
});
