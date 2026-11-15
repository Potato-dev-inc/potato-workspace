// @vitest-environment jsdom
// The standalone Settings window has no tour or guide of its own. "Take the tour", "Feature guide" (and the shortcuts) there
// are sent to the cockpit window as an app event; the cockpit window (AppUpdateHost) answers by opening the tour or guide.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  emit: vi.fn(async () => undefined),
  handlers: new Map<string, (e: { payload: unknown }) => void>(),
  show: vi.fn(async () => undefined),
  focus: vi.fn(async () => undefined),
}));
vi.mock('@tauri-apps/api/event', () => ({
  emit: (...a: unknown[]) => (h.emit as (...x: unknown[]) => Promise<undefined>)(...a),
  listen: async (name: string, cb: (e: { payload: unknown }) => void) => {
    h.handlers.set(name, cb);
    return () => void h.handlers.delete(name);
  },
}));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ close: vi.fn(async () => undefined), show: h.show, setFocus: h.focus }) }));
vi.mock('./lib/cockpit-api', () => ({ cockpitApi: { onSettingsToInline: () => Promise.resolve(() => undefined), openSettings: async () => undefined } }));
vi.mock('./hooks/useProjectPath', () => ({ useProjectPath: () => ({ projectPath: null, setProjectPath: async () => {}, ready: true }) }));
// The panel is stubbed down to the one block with the tour buttons: the real block, in the real window.
vi.mock('./components/SettingsPanel', async () => {
  const { createElement: e } = await import('react');
  const { WhatsNew } = await import('./components/settings/blocks/WhatsNew');
  return { SettingsPanel: () => e(WhatsNew, { env: {} as never }) };
});
vi.mock('./components/history/ImportHost', () => ({ BringChatsHost: () => null }));

import SettingsApp from './SettingsApp';
import { AppUpdateHost } from './components/updates/AppUpdateHost';
import { OPEN_GUIDE_EVENT, WHATSNEW_ASK_EVENT, parseAsk, resetWhatsNewForTests, setWhatsNewRemote, useWhatsNewState } from './whatsnew/store';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  window.localStorage.clear();
  resetWhatsNewForTests();
  h.emit.mockClear();
  h.handlers.clear();
  h.show.mockClear();
  h.focus.mockClear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setWhatsNewRemote(false);
});
const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as HTMLButtonElement;

describe('Settings window: the tour buttons reach the cockpit window', () => {
  it('"Take the tour" and "Feature guide" send an app event instead of opening nothing here', async () => {
    window.history.replaceState(null, '', '/?settings=1&tab=general');
    await act(async () => root.render(createElement(SettingsApp)));
    const guide = vi.fn();
    window.addEventListener(OPEN_GUIDE_EVENT, guide);
    await act(async () => button('Take the tour').click());
    expect(h.emit).toHaveBeenCalledWith(WHATSNEW_ASK_EVENT, { kind: 'tour', version: expect.stringMatching(/^\d+\.\d+\.\d+$/) });
    await act(async () => button('Open the feature guide').click());
    expect(h.emit).toHaveBeenCalledWith(WHATSNEW_ASK_EVENT, { kind: 'guide' });
    // Nothing opened in this window: the guide event is for the cockpit window to raise.
    expect(guide).not.toHaveBeenCalled();
    window.removeEventListener(OPEN_GUIDE_EVENT, guide);
  });
});

describe('Cockpit window: answers the ask', () => {
  function Probe() {
    return <span data-testid="tour-open">{useWhatsNewState().tour?.version ?? 'none'}</span>;
  }
  const mount = async () => {
    await act(async () => root.render(<><AppUpdateHost transport={{ check: async () => null, currentVersion: async () => '1.1.1' } as never} /><Probe /></>));
    await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
  };

  it('a tour ask opens the tour and brings the window forward; a guide ask raises the guide', async () => {
    await mount();
    const on = h.handlers.get(WHATSNEW_ASK_EVENT)!;
    expect(on).toBeDefined();
    const guide = vi.fn();
    window.addEventListener(OPEN_GUIDE_EVENT, guide);
    await act(async () => on({ payload: { kind: 'tour', version: '1.1.1' } }));
    expect(host.querySelector('[data-testid="tour-open"]')!.textContent).toBe('1.1.1');
    expect(h.show).toHaveBeenCalled();
    await act(async () => on({ payload: { kind: 'guide' } }));
    expect(guide).toHaveBeenCalledTimes(1);
    window.removeEventListener(OPEN_GUIDE_EVENT, guide);
  });

  it('only the three known asks are answered; anything else is dropped', () => {
    expect(parseAsk({ kind: 'tour', version: '1.1.1' })).toEqual({ kind: 'tour', version: '1.1.1' });
    expect(parseAsk({ kind: 'tour', version: '<script>' })).toEqual({ kind: 'tour', version: undefined });
    expect(parseAsk({ kind: 'shortcuts' })).toEqual({ kind: 'shortcuts' });
    expect(parseAsk({ kind: 'settings.open' })).toBeNull();
    expect(parseAsk('guide')).toBeNull();
    expect(parseAsk(null)).toBeNull();
  });
});
