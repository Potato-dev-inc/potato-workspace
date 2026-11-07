// @vitest-environment jsdom
// A pane that still asks but has no card (its first read found nothing, or a redraw cleared the card) gets its card
// back by itself, and a card the person just answered does not come back.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCockpit, type CockpitApi } from './useCockpit';

const registry = vi.hoisted(() => ({ status: 'waiting_input' }));
const api_ = vi.hoisted(() => ({ reads: [] as unknown[], answered: 0 }));

vi.mock('./usePaneRegistry', () => ({
  usePaneRegistry: () => {
    const list = [{ info: { id: 'p1', agent_type: 'zeta', cwd: '/p' }, status: registry.status }];
    return { panes: new Map(list.map((p) => [p.info.id, p])), paneList: list, initialReady: true };
  },
}));
vi.mock('../lib/agentRegistry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/agentRegistry')>()),
  useAgentRegistry: () => ({ agents: [], dispatchable_ids: [] }),
}));
vi.mock('../lib/pane-preview', () => ({ usePanePreviews: () => ({}) }));
vi.mock('../lib/pane-activity', () => ({ usePaneActivity: () => ({}) }));
vi.mock('./useBridge', () => ({ useBridge: () => ({ isReady: false, error: null, client: null }) }));
vi.mock('./useQuestions', () => ({ useQuestions: () => ({ questions: [], pending: 0 }) }));
vi.mock('../lib/settings', () => ({
  applyTheme: () => {},
  loadSettings: () => Promise.resolve({}),
  patchSettings: () => Promise.resolve(),
}));
vi.mock('../lib/settings-sync', () => ({ subscribeSettingsTheme: () => () => {} }));
vi.mock('../lib/tauri', () => ({ tauri: { standbyGetStatus: () => Promise.resolve(null) } }));
vi.mock('../lib/cockpit-api', () => ({
  // Every command answers nothing; every `on…` subscription returns an unsubscribe.
  cockpitApi: new Proxy(
    {},
    {
      get: (_t, name: string) => {
        if (name === 'panePrompt') return () => Promise.resolve(api_.reads.length > 1 ? api_.reads.shift() : (api_.reads[0] ?? null));
        if (name === 'answerPanePrompt') return () => (api_.answered++, Promise.resolve());
        return name.startsWith('on') ? () => Promise.resolve(() => {}) : () => Promise.resolve(null);
      },
    },
  ),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The payload shape the backend sends for a menu it read by its shape.
const PROMPT = {
  promptId: 'prompt-1',
  kind: 'unknown_question',
  text: 'Update available',
  choices: [
    { id: 'option_1', label: 'Update now' },
    { id: 'option_2', label: 'Skip' },
  ],
  risk: { level: 'medium', headline: 'The agent asks', reasons: ['Update available'] },
};

let host: HTMLDivElement;
let root: Root;
let api: CockpitApi;
function Probe(_: { tick: number }) {
  api = useCockpit();
  return null;
}
let tick = 0;
const rerender = () => act(async () => root.render(createElement(Probe, { tick: ++tick })));
const later = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

beforeEach(() => {
  vi.useFakeTimers();
  registry.status = 'waiting_input';
  api_.reads = [null];
  api_.answered = 0;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe('a pane that asks but has no card', () => {
  it('gets the card when a later read finds the question, and keeps it', async () => {
    await rerender();
    await later(50);
    expect(api.prompts.p1 ?? null).toBeNull();
    api_.reads = [PROMPT];
    await later(2_100);
    expect(api.prompts.p1?.promptId).toBe('prompt-1');
    await later(5_000);
    expect(api.prompts.p1?.promptId).toBe('prompt-1');
  });

  it('does not put back a card the person just answered, and drops it when the question leaves the screen', async () => {
    api_.reads = [PROMPT];
    await rerender();
    await later(50);
    expect(api.prompts.p1?.promptId).toBe('prompt-1');
    await act(async () => api.answer('p1', 'prompt-1', 'option_1', 'Update now', {} as never));
    registry.status = 'running'; // the agent went on
    await rerender();
    expect(api.prompts.p1 ?? null).toBeNull();
    registry.status = 'waiting_input'; // a redraw reads as waiting for a moment, same screen read
    await rerender();
    await later(2_100);
    expect(api.prompts.p1 ?? null).toBeNull();
  });
});

describe('an answer that did not take', () => {
  it('marks the still-drawn question as stalled after the check, and a second click goes out again', async () => {
    api_.reads = [PROMPT];
    await rerender();
    await later(50);
    await act(async () => api.answer('p1', 'prompt-1', 'option_1', 'Update now', {} as never));
    // A double click while the first is on its way sends nothing more.
    await act(async () => api.answer('p1', 'prompt-1', 'option_1', 'Update now', {} as never));
    expect(api_.answered).toBe(1);
    await later(6_000);
    expect(api.prompts.p1?.stalled).toBe(true);
    await act(async () => api.answer('p1', 'prompt-1', 'option_1', 'Update now', {} as never));
    expect(api_.answered).toBe(2);
  });

  it('says nothing when the question left the screen', async () => {
    api_.reads = [PROMPT];
    await rerender();
    await later(50);
    await act(async () => api.answer('p1', 'prompt-1', 'option_1', 'Update now', {} as never));
    api_.reads = [null];
    await later(6_000);
    expect(api.prompts.p1?.stalled).toBeFalsy();
  });
});
