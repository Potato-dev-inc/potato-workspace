// @vitest-environment jsdom
// "Snooze 30 min" on an Inbox card: one click asks the PC to hold this card's alerts, and the card stays.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetNotifyStoreForTest } from '../../lib/notify-store';
import { InboxCard } from './InboxCard';

const invoke = vi.fn(async (cmd: string) => (cmd === 'notify_prefs_get' ? { bells: {}, quiet: { enabled: false, start: 1320, end: 420 }, snoozes: {}, imported: true } : 1));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => (invoke as (...x: unknown[]) => unknown)(...a) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
  resetNotifyStoreForTest();
  invoke.mockClear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
});

const snoozeBtn = () => host.querySelector<HTMLButtonElement>('[data-snooze]');

describe('Inbox card snooze', () => {
  it('shows Snooze 30 min, asks the PC, then reads Snoozed 30 min and is disabled; the card stays', async () => {
    await act(async () => root.render(<InboxCard kind="question" glyph="needs" title="Which branch?" snoozeKeys={['q-1']} />));
    expect(snoozeBtn()?.textContent).toBe('Snooze 30 min');
    await act(async () => snoozeBtn()!.click());
    expect(invoke).toHaveBeenCalledWith('notify_snooze', { keys: ['q-1'] });
    expect(snoozeBtn()?.textContent).toBe('Snoozed 30 min');
    expect(snoozeBtn()?.disabled).toBe(true);
    expect(host.querySelector('[data-ib-card]')).not.toBeNull();
  });

  it('a card without snooze keys has no button (high risk and consent never snooze)', async () => {
    await act(async () => root.render(<InboxCard kind="consent" glyph="needs" title="Allow?" />));
    expect(snoozeBtn()).toBeNull();
  });
});
