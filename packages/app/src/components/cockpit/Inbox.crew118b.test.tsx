// @vitest-environment jsdom
// 1.1.8 Inbox upgrades 13 and 15, through the real Inbox screen: "By crew" groups cards under the chat that started the
// helpers (urgency stays the default, the choice is remembered, risky asks stay pinned on top), and "Show in crew" opens
// the crew canvas on the box of that chat.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneInfo } from '@potato-workspace/shared';
import type { CockpitApi } from '../../hooks/useCockpit';
import { LoopGuardContext, type LoopSignal } from '../../lib/loop-guard';
import { setStalls } from '../../lib/stalls';
import { rememberCrewStart } from '../../lib/crew-members';
import { Inbox } from './Inbox';

vi.mock('../../lib/collision', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/collision')>()),
  tauriCollisionApi: { list: () => Promise.resolve([]), ignore: vi.fn(), settingsGet: vi.fn(), settingsSet: vi.fn(), onChanged: () => Promise.resolve(() => {}) },
}));
const crewsApi = vi.hoisted(() => ({ open: vi.fn(), agents: vi.fn(), check: vi.fn() }));
vi.mock('../../lib/crews-api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../lib/crews-api')>()), crewsApi, crewsApiFor: () => crewsApi }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OPENED = {
  slug: 'night',
  kind: 'saved',
  crew: {
    name: 'Night crew',
    routing_file: 'r.md',
    roles: [
      { id: 'lead', name: 'Lead', agent_type: 'claude', task: 'Lead.' },
      { id: 'tester', name: 'Tester', agent_type: 'claude', task: 'Test.', parent: 'lead' },
    ],
  },
  routing_text: '',
  problems: [],
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (Element.prototype as { scrollIntoView?: () => void }).scrollIntoView = () => {};
  window.localStorage.setItem('pm.cockpit.everSpawned', '1');
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  crewsApi.open.mockResolvedValue(OPENED);
  crewsApi.agents.mockResolvedValue({ agents: [{ id: 'claude', label: 'Claude' }], default: 'claude' });
  crewsApi.check.mockResolvedValue([]);
});
afterEach(() => {
  act(() => root.unmount());
  act(() => setStalls(new Map()));
  host.remove();
  window.localStorage.clear();
});

const NOW = 3_600_000;
const info = (id: string, status: string, parent?: string): PaneInfo =>
  ({ id, agent_type: 'claude', pid: 1, status, created_at: 1, last_output_at: null, cwd: 'C:\\work\\shop', cols: 80, rows: 24, title: null, ...(parent ? { parent_pane_id: parent } : {}) }) as unknown as PaneInfo;

const highPrompt = {
  promptId: 'p-hi',
  kind: 'command_approval',
  text: 'raw',
  summary: 'Run command: rm',
  choices: [
    { id: 'yes', label: 'Yes' },
    { id: 'no', label: 'No' },
  ],
  risk: { level: 'high', headline: 'Delete a folder outside this project', reasons: ['It cannot be undone.'] },
};

// r started a, b and c; z is its own chat and waits on a risky approval. a and b are stuck (set per test), c is working.
function cockpit() {
  const spec: [string, string, string?][] = [['r', 'idle'], ['a', 'running', 'r'], ['b', 'running', 'r'], ['c', 'running', 'r'], ['z', 'waiting_input']];
  const list = spec.map(([id, status, parent]) => ({ info: info(id, status, parent), status }));
  return {
    registry: { paneList: list, panes: new Map(list.map((p) => [p.info.id, p])), initialReady: true },
    names: new Map(list.map((p) => [p.info.id, `Chat ${p.info.id}`])),
    asked: { questions: [], answerQuestion: vi.fn(), dismissQuestion: vi.fn() },
    activities: {},
    launchEntries: [],
    readyAgents: new Set<string>(),
    mode: 'orchestration',
    theme: 'dark',
    selectedId: null,
    select: vi.fn(),
    prompts: { z: highPrompt },
    statusSince: new Map(list.map((p, i) => [p.info.id, NOW - (i + 1) * 120_000] as const)),
    now: NOW,
    interrupt: vi.fn(),
    newAgent: vi.fn(),
  } as unknown as CockpitApi;
}

const mount = (api: CockpitApi) =>
  act(() =>
    root.render(
      <LoopGuardContext.Provider value={{ signals: {} as Record<string, LoopSignal>, dismiss: () => {} }}>
        <Inbox c={api} />
      </LoopGuardContext.Provider>,
    ),
  );
const button = (label: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent === label) as HTMLButtonElement | undefined;
const keys = (el: ParentNode) => Array.from(el.querySelectorAll('[data-ib-key]')).map((e) => (e as HTMLElement).dataset.ibKey);

describe('Group by crew', () => {
  it('is By urgency by default: one flat list, no groups', () => {
    act(() => setStalls(new Map([['a', 6], ['b', 7]])));
    mount(cockpit());
    expect(host.querySelectorAll('[data-testid="inbox-group"]').length).toBe(0);
    expect(button('By urgency')!.getAttribute('aria-pressed')).toBe('true');
    expect(keys(host)).toEqual(['approval:z', 'stuck:a', 'stuck:b']);
  });

  it('By crew groups cards under the chat that started them, keeps the risky ask pinned on top, and remembers the choice', () => {
    const api = cockpit();
    act(() => setStalls(new Map([['a', 6], ['b', 7]])));
    mount(api);
    act(() => button('By crew')!.click());
    const pinned = host.querySelector('[data-testid="inbox-pinned"]')!;
    expect(keys(pinned)).toEqual(['approval:z']);
    const groups = host.querySelectorAll('[data-testid="inbox-group"]');
    expect(groups.length).toBe(1);
    const group = groups[0];
    // the pinned list comes before every group in the page
    expect(pinned.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(group.getAttribute('data-group')).toBe('r');
    expect(keys(group)).toEqual(['stuck:a', 'stuck:b']);
    // 2 need you; c, under the same chat, is working
    expect(group.querySelector('h2')!.textContent).toContain('Chat r');
    expect(group.querySelector('h2')!.textContent).toContain('2 needs you');
    expect(group.querySelector('h2')!.textContent).toContain('1 working');
    // the heading count does not depend on the view
    expect(host.querySelector('.ck-inbox-count')!.textContent).toBe('3');

    // remembered: a new screen opens in By crew
    act(() => root.unmount());
    root = createRoot(host);
    mount(api);
    expect(button('By crew')!.getAttribute('aria-pressed')).toBe('true');
    act(() => button('By urgency')!.click());
    expect(host.querySelectorAll('[data-testid="inbox-group"]').length).toBe(0);
    expect(window.localStorage.getItem('pm.inbox.view')).toBe('urgency');
  });
});

describe('Show in crew', () => {
  it('shows the button only on a chat that is a crew box, and opens the canvas with that box selected', async () => {
    rememberCrewStart('night', [{ role: 'Tester', pane_id: 'a' }]);
    act(() => setStalls(new Map([['a', 6], ['b', 7]])));
    mount(cockpit());
    const li = (k: string) => host.querySelector(`[data-ib-key="${k}"]`)!;
    expect(li('stuck:a').querySelector('.ib-crew-btn')).not.toBeNull();
    expect(li('stuck:b').querySelector('.ib-crew-btn')).toBeNull();
    expect(li('approval:z').querySelector('.ib-crew-btn')).toBeNull();
    await act(async () => (li('stuck:a').querySelector('.ib-crew-btn') as HTMLButtonElement).click());
    expect(crewsApi.open).toHaveBeenCalledWith('night');
    expect(document.body.textContent).toContain('Night crew');
    expect(document.querySelector('.crewc-box.is-selected')!.textContent).toContain('Tester');
  });

  it('a working row of a crew chat has it too', async () => {
    rememberCrewStart('night', [{ role: 'Lead', pane_id: 'c' }]);
    mount(cockpit());
    const row = host.querySelector('[data-working-row="c"]')!;
    await act(async () => (row.querySelector('button[aria-label="Show Chat c in its crew"]') as HTMLButtonElement).click());
    expect(document.querySelector('.crewc-box.is-selected')!.textContent).toContain('Lead');
    expect(host.querySelector('[data-working-row="a"] button[aria-label^="Show"]')).toBeNull();
  });
});
