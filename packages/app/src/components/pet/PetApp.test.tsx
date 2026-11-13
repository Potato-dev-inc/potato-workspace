// @vitest-environment jsdom
// The Desktop Potato window wired to the app: it draws nothing while the Labs switch is off, it waves when the
// attention list has something for the person, celebrates when a run finishes, and a click opens that agent.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttentionSnapshot } from '../../lib/attention';

const m = vi.hoisted(() => ({
  settings: { desktop_pet_enabled: true, theme: 'dark' } as Record<string, unknown>,
  snapshot: null as unknown,
  handlers: new Map<string, (payload: unknown) => void>(),
  statusHandlers: [] as Array<(e: { pane_id: string; status: string }) => void>,
  invoke: vi.fn(async (_c: string, _a?: unknown): Promise<unknown> => undefined),
  openCockpit: vi.fn(async (_id?: string) => undefined),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: m.invoke }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (event: string, cb: (e: { payload: unknown }) => void) => {
    m.handlers.set(event, (payload) => cb({ payload }));
    return () => m.handlers.delete(event);
  }),
}));
vi.mock('../../lib/settings', () => ({
  loadSettings: vi.fn(async () => m.settings),
  patchSettings: vi.fn(async () => ({})),
  applyTheme: vi.fn(),
}));
vi.mock('../../lib/cockpit-api', () => ({ cockpitApi: { openCockpit: m.openCockpit }, isTauri: () => false }));
vi.mock('../../hooks/useAttention', () => ({ useAttention: () => m.snapshot }));
vi.mock('../../lib/agentRegistry', () => ({ useAgentRegistry: () => ({ agents: [{ id: 'claude_code', label: 'Claude' }] }) }));
vi.mock('../../lib/notify-store', () => ({ loadNotifyPrefs: vi.fn(async () => undefined), readQuiet: () => ({ enabled: false, start: 1320, end: 420 }) }));
vi.mock('../../lib/tauri', () => ({
  tauri: {
    listPanes: vi.fn(async () => [{ id: 'p1', agent_type: 'claude_code', status: 'running' }]),
    onPanesChanged: vi.fn(async () => () => undefined),
    onPtyStatus: vi.fn(async (cb: (e: { pane_id: string; status: string }) => void) => {
      m.statusHandlers.push(cb);
      return () => undefined;
    }),
  },
}));

import PetApp from './PetApp';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const snapshot = (agent: string | null): AttentionSnapshot => ({
  v: 1,
  rev: 1,
  counts: { blocking: 1, ready: 0 },
  items: [
    {
      id: 'x',
      key: 'approval:p1',
      kind: 'approval',
      lane: 'blocking',
      rank: 1,
      state: 'open',
      since_ms: null,
      expires_at_ms: null,
      pane: { id: 'p1', heading: 'Fix it', agent, project: null },
      title: 'Approve',
      sentence: null,
      risk: null,
      prompt: null,
      actions: [],
      resolution: null,
    } as unknown as AttentionSnapshot['items'][number],
  ],
});

let root: Root;
let host: HTMLElement;
const flush = () => act(async () => void (await Promise.resolve()));

beforeEach(async () => {
  m.settings = { desktop_pet_enabled: true, theme: 'dark' };
  m.snapshot = null;
  m.statusHandlers = [];
  m.openCockpit.mockClear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const mount = async () => {
  await act(async () => root.render(<PetApp />));
  await flush();
  await flush();
};

describe('the Desktop Potato window', () => {
  it('draws nothing while the Labs switch is off', async () => {
    m.settings = { desktop_pet_enabled: false };
    await mount();
    expect(host.querySelector('.pet-root')).toBeNull();
  });

  it('with the switch on it shows the resting Potato (small, still, no bubble)', async () => {
    await mount();
    expect(host.querySelector('.pet-sprite')).not.toBeNull();
    expect(host.querySelector('.pet-bubble')).toBeNull();
    expect(document.documentElement.classList.contains('pet-page')).toBe(true);
  });

  it('a waiting agent gets a wave and a bubble with its plain name; a click opens it', async () => {
    m.snapshot = snapshot('claude_code');
    await mount();
    expect(host.querySelector('.pet-bubble')!.textContent).toContain('Claude needs you');
    expect(host.querySelector<HTMLElement>('.pet-sprite')!.dataset.sprite).toBe('wave-hello');
    await act(async () => host.querySelector<HTMLElement>('.pet-body')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, buttons: 1 })));
    await act(async () => host.querySelector<HTMLElement>('.pet-body')!.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 })));
    expect(m.openCockpit).toHaveBeenCalledWith('p1');
    expect(m.invoke).toHaveBeenCalledWith('pet_set_expanded', { expanded: true });
  });

  it('a run that goes from running to idle makes it celebrate with that agent\'s name', async () => {
    await mount();
    expect(m.statusHandlers).toHaveLength(1);
    await act(async () => m.statusHandlers[0]({ pane_id: 'p1', status: 'idle' }));
    expect(host.querySelector<HTMLElement>('.pet-sprite')!.dataset.sprite).toBe('celebrate');
    expect(host.querySelector('.pet-bubble')!.textContent).toContain('Claude finished');
  });
});
