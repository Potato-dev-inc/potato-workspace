// @vitest-environment jsdom
// Workflows on the crew canvas, through the real Settings screen (Labs "Crews" and "Workflows" on): the lead can be marked
// the Front, helpers then say when to use them and what kind they are, the workflow block holds the shared note, the start
// mode and the cap, and Save sends them. With the switch off the control is not there, and a crew without a Front shows none of it.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsPanel, type SettingsApi } from '../SettingsPanel';
import { BASE_SETTINGS, click, settle, type } from '../settings/test-utils';

const plain = {
  name: 'Plain crew',
  roles: [
    { name: 'Lead', agent_type: 'claude', model: 'haiku', task: 'Lead it.' },
    { name: 'Deep', agent_type: 'claude', model: 'sonnet', task: 'Hard work.', parent: 'Lead' },
    { name: 'Quick', agent_type: 'claude', model: 'haiku', task: 'Easy work.', parent: 'Lead' },
  ],
};

let calls: Array<{ command: string; args: Record<string, unknown> | undefined }> = [];
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    switch (command) {
      case 'crews_list':
        return [{ slug: 'plain', name: 'Plain crew', roles: 3, agents: ['claude'], problem: null }];
      case 'crews_templates':
        return [];
      case 'crews_agents':
        return { agents: [{ id: 'claude', label: 'Claude' }], default: 'claude' };
      case 'crews_open':
        return { slug: 'plain', kind: 'saved', crew: plain, routing_text: '', problems: [] };
      case 'crews_check':
        return [];
      case 'crews_save_canvas':
        return { slug: 'plain', errors: [] };
      default:
        throw new Error(`not answered in this test: ${command}`);
    }
  }),
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

let host: HTMLDivElement;
let root: Root;
const mount = async (workflows: boolean) => {
  const settings = { ...BASE_SETTINGS, crews_enabled: true, workflows_enabled: workflows };
  const api: SettingsApi = { load: async () => ({ ...settings }), patch: async () => ({ ...settings }), findBridgeUrl: async () => null, subscribe: () => () => {} };
  await act(async () => root.render(<SettingsPanel open api={api} initialTab="helpers" initialRow="crews-page" />));
  for (let i = 0; i < 100 && !host.querySelector('.crews-page'); i++) await act(async () => new Promise((r) => setTimeout(r, 50)));
  await settle(10);
  await click([...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Open the canvas'));
  await settle(10);
};

beforeEach(() => {
  calls = [];
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

const boxes = () => [...document.querySelectorAll<HTMLElement>('[data-testid="crew-box"]')];
const byId = <T extends HTMLElement>(id: string) => document.querySelector<T>(`[data-testid="${id}"]`);
const button = (label: string) => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);

describe('workflows on the canvas', () => {
  it('marks the lead as the Front, asks each helper when to use it and what kind it is, and saves the workflow', async () => {
    await mount(true);
    expect(byId('workflow-panel')).toBeNull(); // a crew with no Front shows no workflow block
    await click(boxes()[0]);
    const front = byId<HTMLElement>('role-front')!.querySelector('input')!;
    expect(front.checked).toBe(false);
    await click(front);
    expect(boxes()[0].textContent).toContain('Front');
    expect(byId('workflow-panel')).not.toBeNull();
    expect(byId('role-when')).toBeNull(); // the Front itself has no "when to use me"

    await click(boxes()[1]);
    const when = byId<HTMLInputElement>('role-when')!;
    expect(when.value).toBe('Tasks that fit this agent');
    await type(when, 'hard coding tasks');
    expect(boxes()[1].textContent).toContain('hard coding tasks');
    const kind = byId<HTMLSelectElement>('role-kind')!;
    expect(kind.value).toBe('minion');
    await act(async () => {
      kind.value = 'spin_off';
      kind.dispatchEvent(new Event('change', { bubbles: true }));
    });

    await type(byId<HTMLTextAreaElement>('wf-note')!, 'Keep answers short.');
    await click(byId('wf-mode-horde'));
    await type(byId<HTMLInputElement>('wf-cap')!, '2');

    await click(button('Save'));
    await settle(10);
    const sent = calls.filter((c) => c.command === 'crews_save_canvas').pop()!.args!.crew as {
      how_i_work: string;
      start_mode: string;
      helper_cap: number;
      roles: Array<{ name: string; front?: boolean; kind?: string | null; when_to_use?: string | null; parent?: string }>;
    };
    expect(sent).toMatchObject({ how_i_work: 'Keep answers short.', start_mode: 'horde', helper_cap: 2 });
    expect(sent.roles.filter((r) => r.front).map((r) => r.name)).toEqual(['Lead']);
    expect(sent.roles[1]).toMatchObject({ kind: 'spin_off', when_to_use: 'hard coding tasks', parent: 'Lead' });
    expect(sent.roles[2].kind ?? null).toBeNull(); // a minion is the default and is not written
  });

  it('hides the Front control while Labs "Workflows" is off', async () => {
    await mount(false);
    await click(boxes()[0]);
    expect(byId('role-front')).toBeNull();
    expect(byId('workflow-panel')).toBeNull();
  });
});
