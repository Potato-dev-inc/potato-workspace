// @vitest-environment jsdom
// The root of a pulled-out tab's window: its route, what it shows, and Put back. The cockpit hook and the heavy views
// are replaced; no window is made.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TabWindowApp, { tabOfWindow } from './TabWindowApp';
import type { TabWindowsApi } from './lib/tab-windows';
import { useEnglish } from './i18n/test-utils';
import { COMFORT_DEFAULTS } from './lib/comfort/model';
import { setComfort } from './lib/comfort/store';

let registry: { panes: Map<string, { status: string; info: { agent_type: string } }>; initialReady: boolean };
const paneView = vi.fn((_: unknown) => <div data-testid="pane-view" />);
const fileTab = vi.fn((_: unknown) => <div data-testid="file-tab" />);
const seed = vi.fn();
vi.mock('./hooks/useCockpit', () => ({ useCockpit: () => ({ registry, names: new Map([['p1', 'Claude']]) }) }));
vi.mock('./components/cockpit/PaneView', () => ({ PaneView: (props: unknown) => paneView(props), seedRememberedTab: (...a: unknown[]) => seed(...a) }));
vi.mock('./components/files/FileTab', () => ({ FileTab: (props: unknown) => fileTab(props) }));
vi.mock('./lib/settings', () => ({ loadSettings: async () => ({ theme: 'light' }), applyTheme: vi.fn() }));
vi.mock('./lib/settings-sync', () => ({ subscribeSettingsTheme: () => () => undefined }));
vi.mock('./styles/cockpit.css', () => ({}));
vi.mock('./styles/files.css', () => ({}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = (): TabWindowsApi => ({ open: vi.fn(async () => undefined), putBack: vi.fn(async () => undefined), onClosed: vi.fn(async () => () => undefined) });

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  useEnglish();
  registry = { panes: new Map([['p1', { status: 'idle', info: { agent_type: 'claude' } }]]), initialReady: true };
  paneView.mockClear();
  fileTab.mockClear();
  seed.mockClear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  window.history.replaceState(null, '', '/');
});
const at = (search: string) => window.history.replaceState(null, '', `/index.html${search}`);
const show = (a: TabWindowsApi) => act(async () => root.render(<TabWindowApp api={a} />));

describe('the route of a tab window', () => {
  it('reads the pane and the tab from the address', () => {
    expect(tabOfWindow('?tabwin=1&pane=p1&tab=chat')).toEqual({ paneId: 'p1', chat: true, path: null });
    expect(tabOfWindow('?tabwin=1&pane=p1&tab=file%3Asrc%2Fa.ts')).toEqual({ paneId: 'p1', chat: false, path: 'src/a.ts' });
    expect(tabOfWindow('?tabwin=1')).toEqual({ paneId: '', chat: false, path: null });
    expect(tabOfWindow('?tabwin=1&pane=p1&tab=terminal')).toEqual({ paneId: 'p1', chat: false, path: null });
  });
});

describe('the tab window', () => {
  it('shows the same pane for a chat: the pane view in its own window mode, opened on the chat', async () => {
    at('?tabwin=1&pane=p1&tab=chat');
    await show(api());
    expect(host.querySelector('[data-testid="pane-view"]')).not.toBeNull();
    expect((paneView.mock.calls[0][0] as { paneId: string; inWindow: boolean }).paneId).toBe('p1');
    expect((paneView.mock.calls[0][0] as { inWindow: boolean }).inWindow).toBe(true);
    expect(seed).toHaveBeenCalledWith('p1', 'chat');
    expect(host.querySelector('.ck-tabwin-name')?.textContent).toBe('Claude');
    expect(host.querySelector('.ck-tabwin')?.getAttribute('data-theme')).toBe('light');
  });

  it('shows the file for a file tab', async () => {
    at('?tabwin=1&pane=p1&tab=file%3Asrc%2Fa.ts');
    await show(api());
    expect(host.querySelector('[data-testid="file-tab"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="pane-view"]')).toBeNull();
    expect(fileTab.mock.calls[0][0]).toMatchObject({ paneId: 'p1', path: 'src/a.ts' });
    expect(host.querySelector('.ck-tabwin-name')?.textContent).toBe('a.ts');
  });

  it('Put back asks the backend to close the window, for the chat and for a file', async () => {
    at('?tabwin=1&pane=p1&tab=chat');
    const a = api();
    await show(a);
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="tab-put-back"]')!.click());
    expect(a.putBack).toHaveBeenCalledWith('p1', 'chat');

    act(() => root.unmount());
    root = createRoot(host);
    at('?tabwin=1&pane=p1&tab=file%3Asrc%2Fa.ts');
    const b = api();
    await show(b);
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="tab-put-back"]')!.click());
    expect(b.putBack).toHaveBeenCalledWith('p1', 'file:src/a.ts');
  });

  it('says so when the agent is gone, and still offers Put back', async () => {
    at('?tabwin=1&pane=p9&tab=chat');
    await show(api());
    expect(host.textContent).toContain('This agent is not running any more.');
    expect(host.querySelector('[data-testid="tab-put-back"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="pane-view"]')).toBeNull();
  });

  it('shows nothing from an address it does not understand', async () => {
    at('?tabwin=1&pane=p1&tab=terminal');
    await show(api());
    expect(host.querySelector('[data-testid="pane-view"]')).toBeNull();
    expect(host.querySelector('[data-testid="file-tab"]')).toBeNull();
  });
});

describe('text size in the pop-out', () => {
  it('applies the saved text size at open and follows a change', async () => {
    setComfort({ textScale: 130 });
    at('?tabwin=1&pane=p1&tab=chat');
    await show(api());
    expect(document.documentElement.style.getPropertyValue('--ui-scale')).toBe('1.3');
    await act(async () => void setComfort({ textScale: 110 }));
    expect(document.documentElement.style.getPropertyValue('--ui-scale')).toBe('1.1');
    setComfort(COMFORT_DEFAULTS);
  });
});
