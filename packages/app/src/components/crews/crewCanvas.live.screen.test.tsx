// @vitest-environment jsdom
// The live view of a running workflow, through the real Settings screen and the real crew canvas (Labs "Crews" and "Workflows" on).
// A crew started as a workflow (its front chat is remembered) gets a Live tab: the same boxes, one state word and a timer per helper,
// one dot per start and per report, a short log. Reduced motion: no dots, the arrow lights briefly. With the switch off: nothing.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsPanel, type SettingsApi } from '../SettingsPanel';
import { BASE_SETTINGS, click, settle } from '../settings/test-utils';
import { OPEN_HELPER_EVENT } from '../../lib/openHelper';

const crew = {
  name: 'Router',
  roles: [
    { name: 'Front', agent_type: 'claude', model: 'haiku', task: 'Route.', front: true },
    { name: 'Sonnet', agent_type: 'claude', model: 'sonnet', task: 'Hard.', parent: 'Front', when_to_use: 'hard tasks' },
    { name: 'Reviewer', agent_type: 'codex', model: 'gpt', task: 'Review.', parent: 'Front', when_to_use: 'reviews' },
  ],
};

type P = { id: string; agent_type: string; status: string; created_at: number; parent_pane_id: string | null; started_as: string | null; origin?: { task: string }; title?: string };
const NOW = Date.now();
const front = (status = 'running'): P => ({ id: 'front', agent_type: 'claude', status, created_at: NOW - 600000, parent_pane_id: null, started_as: null });
const helper = (id: string, agent: string, status: string, ago: number, task = 'fix login test'): P => ({ id, agent_type: agent, status, created_at: NOW - ago, parent_pane_id: 'front', started_as: 'minion', origin: { task } });

let panes: P[] = [];
let listeners: Record<string, Array<(e: { payload: unknown }) => void>> = {};
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string) => {
    switch (command) {
      case 'crews_list':
        return [{ slug: 'wf', name: 'Router', roles: 3, agents: ['claude'], problem: null }];
      case 'crews_templates':
        return [];
      case 'crews_agents':
        return { agents: [{ id: 'claude', label: 'Claude' }, { id: 'codex', label: 'Codex' }], default: 'claude' };
      case 'crews_open':
        return { slug: 'wf', kind: 'saved', crew, routing_text: '', problems: [] };
      case 'crews_check':
        return [];
      case 'list_panes':
        return panes.map((p) => ({ ...p, pid: 1, last_output_at: null, cwd: 'C:/x', cols: 80, rows: 24 }));
      default:
        throw new Error(`not answered in this test: ${command}`);
    }
  }),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, cb: (e: { payload: unknown }) => void) => {
    (listeners[name] ??= []).push(cb);
    return () => {
      listeners[name] = (listeners[name] ?? []).filter((x) => x !== cb);
    };
  }),
}));

let host: HTMLDivElement;
let root: Root;
const mount = async (workflows: boolean) => {
  const settings = { ...BASE_SETTINGS, crews_enabled: true, workflows_enabled: workflows };
  const api: SettingsApi = { load: async () => ({ ...settings }), patch: async () => ({ ...settings }), findBridgeUrl: async () => null, subscribe: () => () => {} };
  await act(async () => root.render(<SettingsPanel open api={api} initialTab="helpers" initialRow="crews-page" />));
  for (let i = 0; i < 100 && !host.querySelector('.crews-page'); i++) await act(async () => new Promise((r) => setTimeout(r, 50)));
  await settle(10);
  await click([...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Open the canvas'));
  await settle(15);
};
/** The app says the panes changed: the canvas reads them again. */
const changed = async () => {
  await act(async () => {
    for (const cb of listeners['pty://panes-changed'] ?? []) cb({ payload: {} });
  });
  await act(async () => new Promise((r) => setTimeout(r, 250))); // reads are batched (150 ms)
  await settle(10);
};
const reduceMotion = (on: boolean) => {
  window.matchMedia = ((q: string) => ({ matches: on && q.includes('reduce'), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as never;
};

beforeEach(() => {
  panes = [];
  listeners = {};
  localStorage.setItem('pm.crew.members', JSON.stringify({ front: { slug: 'wf', role: 'Front', front: true } }));
  reduceMotion(false);
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  localStorage.clear();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

const byId = <T extends HTMLElement>(id: string) => document.querySelector<T>(`[data-testid="${id}"]`);
const box = (role: string) => document.querySelector<HTMLElement>(`[data-testid="crew-box"][data-role="${role}"]`)!;
const tab = (name: string) => [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find((b) => b.textContent?.trim() === name);
const openLive = async () => {
  await click(tab('Live'));
  await settle(5);
};
const remount = async (workflows: boolean) => {
  await act(async () => root.unmount());
  root = createRoot(host);
  await mount(workflows);
};

describe('the live view on the crew canvas', () => {
  it('has a Live tab only while a chat started as this workflow exists, and only with the Labs switch on', async () => {
    await mount(true);
    expect(tab('Live')).toBeUndefined(); // the workflow was never started
    panes = [front()];
    await remount(false);
    expect(tab('Live')).toBeUndefined(); // switch off: nothing new anywhere
    expect(byId('live-log')).toBeNull();
    await remount(true);
    expect(tab('Live')).toBeDefined();
  });

  it('has no Live tab in the separate Settings window (it cannot open a chat in the cockpit window)', async () => {
    panes = [front()];
    window.history.replaceState(null, '', '/?settings=1');
    await mount(true);
    window.history.replaceState(null, '', '/');
    expect(tab('Live')).toBeUndefined();
  });

  it('shows one state word and a timer per helper box, the front glowing, and no percentages or token counts', async () => {
    panes = [front('running'), helper('s1', 'claude', 'running', 65000), helper('r1', 'codex', 'waiting_input', 20000, 'check the diff')];
    await mount(true);
    await openLive();
    expect(box('Front').classList.contains('is-working')).toBe(true);
    expect(box('Sonnet').textContent).toContain('Working');
    expect(box('Sonnet').textContent).toMatch(/1m/);
    expect(box('Reviewer').textContent).toContain('Needs you');
    expect(box('Reviewer').getAttribute('data-live-state')).toBe('needs-you');
    expect(byId('live-summary')!.textContent).toBe('1 agent working, 1 needs you');
    expect(document.querySelector('.crewc')!.textContent).not.toMatch(/%|tokens/i);
  });

  it('shows a failed helper, and opens a helper when its box is clicked', async () => {
    panes = [front('idle'), helper('s1', 'claude', 'error', 30000)];
    await mount(true);
    await openLive();
    expect(box('Front').classList.contains('is-working')).toBe(false);
    expect(box('Sonnet').textContent).toContain('Failed');
    const seen: unknown[] = [];
    const on = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener(OPEN_HELPER_EVENT, on);
    await click(box('Sonnet'));
    await click(box('Reviewer')); // a box nobody stands in does nothing
    window.removeEventListener(OPEN_HELPER_EVENT, on);
    expect(seen).toEqual([{ parentId: 'front', id: 's1' }]);
  });

  it('writes the log in plain words, newest last, at most four lines', async () => {
    panes = [front(), helper('s1', 'claude', 'running', 65000), helper('r1', 'codex', 'waiting_input', 20000, 'check the diff')];
    await mount(true);
    await openLive();
    const lines = [...byId('live-log')!.querySelectorAll('li')].map((li) => li.textContent ?? '');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('Sonnet started: fix login test');
    expect(lines[2]).toContain('Reviewer needs you');
    panes = [front(), helper('s1', 'claude', 'idle', 65000), helper('r1', 'codex', 'waiting_input', 20000, 'check the diff')];
    await changed();
    const after = [...byId('live-log')!.querySelectorAll('li')].map((li) => li.textContent ?? '');
    expect(after).toHaveLength(4);
    expect(after[3]).toMatch(/Sonnet finished \(1m\)/);
  });

  it('sends one dot down when a helper starts and one up when it reports back, and is still otherwise', async () => {
    panes = [front()];
    await mount(true);
    await openLive();
    expect(document.querySelectorAll('[data-testid="live-dot"]')).toHaveLength(0);
    panes = [front(), helper('s1', 'claude', 'running', 1000)];
    await changed();
    const down = document.querySelectorAll('[data-testid="live-dot"]');
    expect(down).toHaveLength(1);
    expect(down[0].getAttribute('data-dir')).toBe('down');
    expect(down[0].getAttribute('data-role')).toBe('Sonnet');
    await changed(); // nothing new: no second dot
    expect(document.querySelectorAll('[data-testid="live-dot"]')).toHaveLength(1);
    panes = [front(), helper('s1', 'claude', 'idle', 5000)];
    await changed();
    expect([...document.querySelectorAll('[data-testid="live-dot"]')].map((d) => d.getAttribute('data-dir')).sort()).toEqual(['down', 'up']);
  });

  it('with reduced motion draws no dots: the arrow lights briefly and the state word changes', async () => {
    reduceMotion(true);
    panes = [front()];
    await mount(true);
    await openLive();
    panes = [front(), helper('s1', 'claude', 'running', 1000)];
    await changed();
    expect(document.querySelectorAll('[data-testid="live-dot"]')).toHaveLength(0);
    expect(document.querySelectorAll('.crewc-line.is-pulse').length).toBeGreaterThan(0);
    expect(box('Sonnet').textContent).toContain('Working');
  });
});
