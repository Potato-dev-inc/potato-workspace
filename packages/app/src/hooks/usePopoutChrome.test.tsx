// @vitest-environment jsdom
// Both pop-out entries (the tab window and the artifact window) get text size, theme and language from one hook.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const calls = vi.hoisted(() => ({ comfort: 0, language: 0, languageOff: 0, theme: [] as string[], emit: (_t: string) => undefined as void }));
vi.mock('../lib/comfort/root', () => ({ useComfortRoot: () => void calls.comfort++ }));
vi.mock('../i18n/sync', () => ({ startLanguageSync: () => (calls.language++, () => void calls.languageOff++) }));
vi.mock('../lib/settings', () => ({ loadSettings: async () => ({ theme: 'light' }), applyTheme: (t: string) => void calls.theme.push(t) }));
vi.mock('../lib/settings-sync', () => ({ subscribeSettingsTheme: (cb: (t: string) => void) => ((calls.emit = cb as never), () => undefined) }));

import { usePopoutChrome } from './usePopoutChrome';

function Probe() {
  return <div data-testid="t">{usePopoutChrome()}</div>;
}

afterEach(() => void Object.assign(calls, { comfort: 0, language: 0, languageOff: 0, theme: [] }));

describe('usePopoutChrome', () => {
  it('applies comfort, starts language sync, loads and follows the theme, and stops on unmount', async () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    await act(async () => root.render(<Probe />));
    await act(async () => undefined);
    expect(calls.comfort).toBeGreaterThan(0);
    expect(calls.language).toBe(1);
    expect(host.textContent).toBe('light');
    await act(async () => calls.emit('dark'));
    expect(host.textContent).toBe('dark');
    expect(calls.theme).toEqual(['light', 'dark']);
    await act(async () => root.unmount());
    expect(calls.languageOff).toBe(1);
  });

  it('both window entries use the hook and neither wires comfort or theme by hand', () => {
    for (const file of ['../TabWindowApp.tsx', '../components/artifacts/ArtifactWindowApp.tsx']) {
      const src = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(src).toContain('usePopoutChrome()');
      expect(src).not.toContain('useComfortRoot');
      expect(src).not.toContain('subscribeSettingsTheme');
    }
  });
});
