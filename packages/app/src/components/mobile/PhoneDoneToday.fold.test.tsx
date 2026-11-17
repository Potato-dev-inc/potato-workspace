// @vitest-environment jsdom
// Phone "Done today" in the drawer: minimize it to one row, or hide it for the day (remembered in localStorage; back tomorrow).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PaneInfo } from '@potato-workspace/shared';
import type { BridgeClient } from '../../lib/bridge';
import { PHONE_PANES } from '../../dev/phone-fixtures';
import { PHONE_HELPERS, phoneDoneReply } from '../../dev/phone-home-fixtures';
import { phoneTeamReply } from '../../dev/phone-team-fixtures';
import { useChinese, useEnglish } from '../../i18n/test-utils';
import { startOfDay } from '../../lib/done-today';
import { PhoneDrawer } from './PhoneDrawer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  useEnglish();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useEnglish();
});

const panes = PHONE_PANES as unknown as PaneInfo[];
const labels = new Map(PHONE_PANES.map((p) => [p.id, p.title ?? p.agent_type]));
const bridge = { phoneDone: async () => phoneDoneReply(), teamCards: async () => phoneTeamReply(), phoneHelpers: async () => PHONE_HELPERS } as unknown as BridgeClient;

async function drawer() {
  await act(async () => {
    root.render(
      <PhoneDrawer open onClose={() => undefined} panes={panes} labels={labels} agentName={(id) => id} attention={null} active="" bridgeReady onSelect={() => undefined} onSearch={() => undefined} onSettings={() => undefined} bridge={bridge} />,
    );
  });
  for (let i = 0; i < 4; i++) await act(async () => {});
}
const done = () => host.querySelector('[data-testid="phone-done-today"]');
const click = async (id: string) => act(async () => host.querySelector<HTMLElement>(`[data-testid="${id}"]`)!.click());

describe('phone Done today: minimize and hide', () => {
  it('minimizes to one row, remembers it, and opens again', async () => {
    await drawer();
    expect(done()!.querySelectorAll('[data-done-row]').length).toBeGreaterThan(0);
    await click('phone-done-fold');
    expect(done()!.querySelectorAll('[data-done-row]').length).toBe(0);
    expect(done()!.querySelector('h2')!.textContent).toContain('Done today');
    expect(done()!.querySelector('.ph-ibx-more')).toBeNull();
    expect(localStorage.getItem('pm.phone.doneToday.min')).toBe('1');
    // a fresh mount stays minimized
    act(() => root.unmount());
    root = createRoot(host);
    await drawer();
    expect(done()!.querySelectorAll('[data-done-row]').length).toBe(0);
    await click('phone-done-fold');
    expect(done()!.querySelectorAll('[data-done-row]').length).toBeGreaterThan(0);
    expect(localStorage.getItem('pm.phone.doneToday.min')).toBeNull();
  });

  it('hides for the day, and only for the day', async () => {
    await drawer();
    await click('phone-done-hide');
    expect(done()).toBeNull();
    expect(host.querySelector('[data-testid="phone-team-activity"]')).not.toBeNull(); // Team activity stays
    act(() => root.unmount());
    root = createRoot(host);
    await drawer();
    expect(done()).toBeNull();
    // tomorrow it is back
    localStorage.setItem('pm.phone.doneToday.hiddenDay', String(startOfDay(Date.now()) - 86_400_000));
    act(() => root.unmount());
    root = createRoot(host);
    await drawer();
    expect(done()).not.toBeNull();
  });

  it('works when storage is blocked', async () => {
    const real = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error('blocked');
    };
    try {
      await drawer();
      await click('phone-done-fold');
      expect(done()!.querySelectorAll('[data-done-row]').length).toBe(0);
    } finally {
      Storage.prototype.setItem = real;
    }
  });

  it('has no English left in Traditional Chinese', async () => {
    useChinese();
    await drawer();
    expect(done()!.querySelector('[data-testid="phone-done-hide"]')!.getAttribute('aria-label')).toBe('今天先隱藏「今天完成」');
    expect(done()!.querySelector('h2')!.textContent).toContain('今天完成');
    expect(done()!.querySelector('[data-testid="phone-done-fold"]')!.getAttribute('aria-label')).toBe('收合「今天完成」');
  });
});
