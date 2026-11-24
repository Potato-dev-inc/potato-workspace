// @vitest-environment jsdom
// "Use my own agents" (P6.1) screens on THIS PC: the chip of a far chat that runs on my lend reads "My sign-in from <this PC>" and
// shows this PC's own numbers and sign-in state; Connect says "Uses your sign-ins from this PC" on that PC's row with Stop, which
// takes the lend back. Nothing for a pane that is not on a lend of mine.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevicesFake, MAC_MINI, NODE_MAC } from '../../dev/devices-fixtures';
import { createFakeLendApi, GRANT_OUT, lendState } from '../../dev/lend-fixtures';
import { setLanguagePref } from '../../i18n';
import type { Grant } from '../../lib/lend';
import { click, settle } from '../settings/test-utils';
import { LentChip, lentPaneOf, usageFarOf } from './LentChip';
import { LentToPc } from './LentToPc';
import { useLend } from './useLend';

vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = '';
  setLanguagePref('en', false);
});

const PANE = `dev:${NODE_MAC}:p9`;
const lent = (over: Partial<Grant> = {}): Grant => ({ ...GRANT_OUT, id: 'lg_mine', peer_member_id: 'me', peer_name: '', peer_device_name: 'Mac mini', peer_node: NODE_MAC, for_other_person: false, pane_ids: [PANE], ends_ms: Date.now() + 11 * 3600_000, ...over });

function Both({ api, devices }: { api: ReturnType<typeof createFakeLendApi>; devices: DevicesFake }) {
  const lend = useLend(api);
  return (
    <>
      <LentChip paneId={PANE} api={api} devices={devices} lend={lend} />
      <LentChip paneId="dev:other:p1" api={api} devices={devices} lend={lend} />
      <LentToPc node={NODE_MAC} name="Mac mini" lend={lend} api={api} />
      <LentToPc node="someone-else" name="Else" lend={lend} api={api} />
    </>
  );
}

describe('Use my own agents on this PC', () => {
  it('the chip of a far chat on my lend reads "My sign-in from <this PC>"; another pane has none', async () => {
    const api = createFakeLendApi(lendState({ grants: [lent({ requests: 3, input_tokens: 1200, output_tokens: 300 })] }));
    const devices = new DevicesFake({ enabled: true, name: 'Desk-PC', devices: [MAC_MINI] });
    await act(async () => root.render(<Both api={api} devices={devices} />));
    await settle(8);
    const chips = host.querySelectorAll('[data-testid="lent-chip"]');
    expect(chips).toHaveLength(1);
    expect(chips[0]!.textContent).toBe('My sign-in from Desk-PC');
    await click(chips[0]);
    expect(document.querySelector('[data-testid="lent-usage"]')!.textContent).toContain('Used so far');
    expect(document.querySelector('.lend-pop')!.classList.contains('fl-layer')).toBe(true); // in the shared top layer, not clipped by the header
    expect(document.querySelector('[data-testid="lent-problem"]')).toBeNull();
  });

  it('this PC\'s own sign-in problem shows on the chip (the lender\'s sign-in is this PC\'s)', async () => {
    const api = createFakeLendApi(lendState({ grants: [lent({ problem: 'The lender\'s sign-in expired. Ask them to sign in again.', problem_kind: 'signin' })] }));
    await act(async () => root.render(<Both api={api} devices={new DevicesFake({ enabled: true, name: 'Desk-PC', devices: [MAC_MINI] })} />));
    await settle(8);
    await click(host.querySelector('[data-testid="lent-chip"]'));
    expect(document.querySelector('[data-testid="lent-problem"]')).not.toBeNull();
  });

  it('Connect names the PC that uses my sign-ins, and Stop takes the lend back', async () => {
    const api = createFakeLendApi(lendState({ grants: [lent()] }));
    await act(async () => root.render(<Both api={api} devices={new DevicesFake({ enabled: true, name: 'Desk-PC', devices: [MAC_MINI] })} />));
    await settle(8);
    const row = host.querySelector(`[data-testid="connect-lent-${NODE_MAC}"]`)!;
    expect(row.textContent).toBe('Uses your sign-ins from this PC · Stop');
    expect(host.querySelector('[data-testid="connect-lent-someone-else"]')).toBeNull();
    await click(host.querySelector(`[data-testid="connect-lent-stop-${NODE_MAC}"]`));
    await settle(8);
    expect(api.state).toBeDefined();
    expect(host.querySelector(`[data-testid="connect-lent-${NODE_MAC}"]`)).toBeNull();
  });

  it('says the same in Traditional Chinese', async () => {
    setLanguagePref('zh-TW', false);
    const api = createFakeLendApi(lendState({ grants: [lent()] }));
    await act(async () => root.render(<Both api={api} devices={new DevicesFake({ enabled: true, name: 'Desk-PC', devices: [MAC_MINI] })} />));
    await settle(8);
    expect(host.querySelector('[data-testid="lent-chip"]')!.textContent).toBe('來自Desk-PC的我的帳號');
    expect(host.querySelector(`[data-testid="connect-lent-${NODE_MAC}"]`)!.textContent).toBe('使用你這台電腦的帳號 · 停止');
  });

  it("the usage bar of a far chat on my lend is this PC's; any other far chat keeps the far PC's", () => {
    const handle = (grants: Grant[]) => ({ state: lendState({ grants }), enabled: true, known: true, now: Date.now(), refresh: () => undefined });
    const far = { node: NODE_MAC, name: 'Mac mini' };
    const mine = handle([lent()]);
    expect(usageFarOf(far, mine, PANE)).toBeNull();
    expect(usageFarOf(far, mine, 'dev:other:p1')).toBe(far);
    expect(usageFarOf(far, handle([]), PANE)).toBe(far);
    expect(usageFarOf(null, mine, PANE)).toBeNull();
    // A lend that is over still reads as this PC's (the sign-in is here, and the chat is not on the far PC's own); a teammate's lend (no PC of mine) is not mine.
    expect(usageFarOf(far, handle([lent({ state: 'ended' })]), PANE)).toBeNull();
    expect(usageFarOf(far, handle([lent({ peer_node: undefined })]), PANE)).toBe(far);
    expect(lentPaneOf(mine, PANE)?.mine).toBe(true);
  });
});
