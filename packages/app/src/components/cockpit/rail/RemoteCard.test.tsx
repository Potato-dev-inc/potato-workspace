// @vitest-environment jsdom
import type { PairedDeviceInfo } from '@potato-workspace/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLanguagePref } from '../../../i18n';
import { useChinese, useEnglish, visibleEnglish } from '../../../i18n/test-utils';
import { effectiveLevel, phoneLevel } from '../../../lib/pane-remote';
import { RemoteCard, type RemoteApi } from './RemoteCard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  useEnglish();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setLanguagePref('auto', false);
});

const phone = (id: string, name: string, caps?: PairedDeviceInfo['caps']): PairedDeviceInfo => ({
  id,
  name,
  public_key: 'k',
  paired_at: 1,
  caps,
  expired: false,
});
const api = (phones: PairedDeviceInfo[], rule = { remote: true, level: 'full' as const }): RemoteApi & { set: ReturnType<typeof vi.fn> } => ({
  get: vi.fn(async () => rule),
  set: vi.fn(async (_id: string, change: object) => ({ ...rule, ...change })),
  phones: vi.fn(async () => phones),
});
const mount = async (a: RemoteApi, onPair?: () => void) => {
  await act(async () => root.render(<RemoteCard paneId="p1" api={a} onPair={onPair} />));
  await act(async () => {});
};
const click = async (el: Element | null) => {
  await act(async () => void (el as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true })));
};

describe('RemoteCard', () => {
  it('shows the switch, the level and each paired phone with how far it goes here', async () => {
    await mount(api([phone('a', "Ren's iPhone", ['watch', 'answer']), phone('b', 'Old phone')], { remote: true, level: 'full' }));
    expect(host.querySelector('[data-testid="rail-remote"]')).not.toBeNull();
    expect(host.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('true');
    const rows = [...host.querySelectorAll('[data-testid="rail-remote-phone"]')].map((r) => r.textContent);
    expect(rows[0]).toContain("Ren's iPhone");
    expect(rows[0]).toContain('Watch and answer');
    expect(rows[1]).toContain('Full control');
  });

  it('the switch calls the command and turns the level off with it', async () => {
    const a = api([phone('a', 'Phone', ['watch'])]);
    await mount(a);
    await click(host.querySelector('[role="switch"]'));
    expect(a.set).toHaveBeenCalledWith('p1', { remote: false });
    expect(host.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('false');
    expect([...host.querySelectorAll('[role="radio"]')].every((r) => (r as HTMLButtonElement).disabled)).toBe(true);
    expect(host.textContent).toContain('Off');
    expect(host.querySelector('[data-testid="rail-remote-phone"]')?.textContent).toContain('No access');
  });

  it('a level pick calls the command', async () => {
    const a = api([phone('a', 'Phone')]);
    await mount(a);
    await click([...host.querySelectorAll('[role="radio"]')].find((r) => r.textContent === 'Watch') ?? null);
    expect(a.set).toHaveBeenCalledWith('p1', { level: 'watch' });
  });

  it('a failed save puts the old rule back and says so', async () => {
    const a = api([phone('a', 'Phone')]);
    a.set.mockRejectedValueOnce(new Error('no'));
    await mount(a);
    await click(host.querySelector('[role="switch"]'));
    await act(async () => {});
    expect(host.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('true');
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('with no phone paired it offers Pair a phone and no switch', async () => {
    const onPair = vi.fn();
    await mount(api([]), onPair);
    expect(host.querySelector('[role="switch"]')).toBeNull();
    await click([...host.querySelectorAll('button')].find((b) => b.textContent === 'Pair a phone') ?? null);
    expect(onPair).toHaveBeenCalledTimes(1);
    await click([...host.querySelectorAll('button')].find((b) => b.textContent === 'Connect a computer') ?? null);
    expect(onPair).toHaveBeenCalledTimes(2);
  });

  it('is in Chinese with no English left over', async () => {
    useChinese();
    await mount(api([phone('a', 'iPhone', ['watch'])]));
    expect(host.textContent).toContain('遠端控制');
    expect(visibleEnglish(host, ['iPhone'])).toEqual([]);
  });
});

describe('levels', () => {
  it('a phone is never raised above its own level, and an agent that is off allows nothing', () => {
    expect(phoneLevel(['watch', 'answer'])).toBe('answer');
    expect(phoneLevel(undefined)).toBe('full');
    expect(phoneLevel([])).toBeNull();
    expect(effectiveLevel({ remote: true, level: 'full' }, ['watch'])).toBe('watch');
    expect(effectiveLevel({ remote: true, level: 'watch' }, ['watch', 'answer', 'type'])).toBe('watch');
    expect(effectiveLevel({ remote: false, level: 'full' }, ['watch'])).toBeNull();
  });
});
