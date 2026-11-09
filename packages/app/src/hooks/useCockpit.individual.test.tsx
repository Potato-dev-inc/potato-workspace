// @vitest-environment jsdom
// The first switch to Individual explains itself once; a launch that fell back says so and offers the way back.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCockpit, type CockpitApi } from './useCockpit';

const m = vi.hoisted(() => ({
  explained: false,
  fellBack: false,
  setUiMode: vi.fn(async (_mode: string) => {}),
  patch: vi.fn(async (_p: unknown) => {}),
}));

vi.mock('./usePaneRegistry', () => ({ usePaneRegistry: () => ({ panes: new Map(), paneList: [], initialReady: true }) }));
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
  loadSettings: () => Promise.resolve({ individual_explained: m.explained }),
  patchSettings: (p: unknown) => m.patch(p),
}));
vi.mock('../lib/settings-sync', () => ({ subscribeSettingsTheme: () => () => {} }));
vi.mock('../lib/tauri', () => ({ tauri: { standbyGetStatus: () => Promise.resolve(null) } }));
vi.mock('../lib/cockpit-api', () => ({
  cockpitApi: new Proxy(
    {},
    {
      get: (_t, name: string) => {
        if (name === 'setUiMode') return (mode: string) => m.setUiMode(mode);
        if (name === 'takeIndividualFallback') return () => Promise.resolve(m.fellBack);
        if (name === 'getUiMode') return () => Promise.resolve('orchestration');
        return name.startsWith('on') ? () => Promise.resolve(() => {}) : () => Promise.resolve(null);
      },
    },
  ),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let api: CockpitApi;
function Probe() {
  api = useCockpit();
  return null;
}
async function mount() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(Probe)));
}

beforeEach(() => {
  m.explained = false;
  m.fellBack = false;
  m.setUiMode.mockClear();
  m.patch.mockClear();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('first switch to Individual', () => {
  it('opens the sheet instead of switching; Switch applies the mode and remembers it, so it shows once', async () => {
    await mount();
    await act(async () => api.setMode('individual'));
    expect(api.modeExplainer.open).toBe(true);
    expect(m.setUiMode).not.toHaveBeenCalled();

    await act(async () => api.modeExplainer.confirm(true));
    expect(m.setUiMode).toHaveBeenCalledWith('individual');
    expect(m.patch).toHaveBeenCalledWith({ individual_explained: true });
    expect(api.modeExplainer.open).toBe(false);

    await act(async () => api.setMode('orchestration'));
    await act(async () => api.setMode('individual'));
    expect(api.modeExplainer.open).toBe(false);
    expect(m.setUiMode).toHaveBeenLastCalledWith('individual');
  });

  it('Cancel switches nothing and saves nothing', async () => {
    await mount();
    await act(async () => api.setMode('individual'));
    act(() => api.modeExplainer.cancel());
    expect(api.modeExplainer.open).toBe(false);
    expect(m.setUiMode).not.toHaveBeenCalled();
    expect(m.patch).not.toHaveBeenCalled();
  });

  it('switches straight away once the sheet was dismissed for good', async () => {
    m.explained = true;
    await mount();
    await act(async () => api.setMode('individual'));
    expect(api.modeExplainer.open).toBe(false);
    expect(m.setUiMode).toHaveBeenCalledWith('individual');
  });

  it('never asks for Orchestration', async () => {
    await mount();
    await act(async () => api.setMode('orchestration'));
    expect(api.modeExplainer.open).toBe(false);
    expect(m.setUiMode).toHaveBeenLastCalledWith('orchestration');
  });
});

describe('launch that fell back from Individual', () => {
  it('shows "You were in Individual mode" with Switch back, which switches without the sheet', async () => {
    m.fellBack = true;
    await mount();
    const toast = api.toasts.find((t) => t.text === 'You were in Individual mode');
    expect(toast?.action?.label).toBe('Switch back');
    await act(async () => toast!.action!.run());
    expect(m.setUiMode).toHaveBeenCalledWith('individual');
    expect(api.modeExplainer.open).toBe(false);
  });

  it('says nothing on a normal launch', async () => {
    await mount();
    expect(api.toasts).toHaveLength(0);
  });
});
