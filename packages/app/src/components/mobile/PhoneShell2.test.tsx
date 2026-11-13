// @vitest-environment jsdom
// Phone part 2 around the chat: the drawer (lock, long press: Stop and Close), the connection line, the setup steps and Help.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PHONE_PANES } from '../../dev/phone-fixtures';
import { PANE_CODEX } from '../../dev/fixtures';
import type { PushDeps, PushEnv } from '../../lib/push-client';
import { DEFAULT_PUBLIC_SETTINGS } from '../../lib/bridge-settings';
import { LONG_PRESS_MS, PhoneDrawer } from './PhoneDrawer';
import { PhoneHeader } from './PhoneHeader';
import { PhoneLinkLine } from './PhoneLinkLine';
import { PhoneSetupSteps } from './PhoneSetupSteps';
import { MenuSheet } from './MobileSheet';
import { ControlAskNotice } from '../cockpit/ControlAskNotice';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tauriMock = vi.hoisted(() => ({
  asks: [] as unknown[],
  listeners: [] as Array<(ask: unknown) => void>,
  answer: vi.fn(async () => undefined),
}));
vi.mock('../../lib/tauri', () => ({
  tauri: {
    listControlAsks: async () => tauriMock.asks,
    onControlAsk: async (cb: (ask: unknown) => void) => {
      tauriMock.listeners.push(cb);
      return () => undefined;
    },
    answerControlAsk: tauriMock.answer,
  },
}));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});
async function render(node: React.ReactNode) {
  await act(async () => { root.render(node); });
}

const labels = new Map(PHONE_PANES.map((p) => [p.id, p.title ?? p.agent_type]));
const drawer = (over: Partial<React.ComponentProps<typeof PhoneDrawer>> = {}) => (
  <PhoneDrawer
    open
    onClose={() => undefined}
    panes={PHONE_PANES.filter((p) => p.agent_type !== 'powershell')}
    labels={labels}
    agentName={(id) => id}
    attention={null}
    active=""
    bridgeReady
    onSelect={() => undefined}
    onSearch={() => undefined}
    onOverview={() => undefined}
    onSettings={() => undefined}
    {...over}
  />
);
const row = (id: string) => [...host.querySelectorAll('.ph-drow')].find((el) => el.textContent?.includes(labels.get(id) ?? '???')) as HTMLButtonElement;

describe('P20: a lock on the drawer row', () => {
  it('shows a lock with words for an agent the PC limits, and none for the others', async () => {
    await render(drawer({ locks: { [PANE_CODEX]: 'watch' } }));
    const locks = host.querySelectorAll('.ph-lock');
    expect(locks).toHaveLength(1);
    expect(locks[0].getAttribute('aria-label')).toBe('Watch only on this phone');
    expect(row(PANE_CODEX).querySelector('.ph-lock')).not.toBeNull();
  });

  it('says so for a switched-off agent', async () => {
    await render(drawer({ locks: { [PANE_CODEX]: 'off' } }));
    expect(host.querySelector('.ph-lock')?.getAttribute('aria-label')).toBe('Remote control is off for this agent');
  });
});

describe('P9: long press on a drawer row', () => {
  it('opens a small menu with Stop and Close, and a short tap still opens the chat', async () => {
    const onSelect = vi.fn();
    const onStopPane = vi.fn(async () => null);
    const onClosePane = vi.fn();
    await render(drawer({ onSelect, onStopPane, onClosePane }));
    const el = row(PANE_CODEX);
    // A short tap opens the chat.
    await act(async () => { el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); el.dispatchEvent(new MouseEvent('pointerup', { bubbles: true })); el.click(); });
    expect(onSelect).toHaveBeenCalledWith(PANE_CODEX);
    expect(host.querySelector('[data-testid="drawer-row-menu"]')).toBeNull();
    // A long press opens the menu and does not open the chat.
    onSelect.mockClear();
    await act(async () => { el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(LONG_PRESS_MS + 20); });
    expect(host.querySelector('[data-testid="drawer-row-menu"]')).not.toBeNull();
    await act(async () => { el.dispatchEvent(new MouseEvent('pointerup', { bubbles: true })); el.click(); });
    expect(onSelect).not.toHaveBeenCalled();
    // Stop.
    await act(async () => { ([...host.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent === 'Stop') as HTMLButtonElement).click(); await Promise.resolve(); });
    expect(onStopPane).toHaveBeenCalledWith(PANE_CODEX);
  });

  it('the keyboard context key opens the same menu; Close asks first', async () => {
    const onClosePane = vi.fn();
    await render(drawer({ onStopPane: async () => null, onClosePane }));
    await act(async () => { row(PANE_CODEX).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); });
    const close = ([...host.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent === 'Close') as HTMLButtonElement);
    await act(async () => close.click());
    expect(onClosePane).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Close this chat? The agent stops.');
    await act(async () => { ([...host.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent === 'Close it') as HTMLButtonElement).click(); });
    expect(onClosePane).toHaveBeenCalledWith(PANE_CODEX);
  });

  it('shows why when the PC refuses the stop', async () => {
    await render(drawer({ onStopPane: async () => 'This phone may not stop this agent.', onClosePane: () => undefined }));
    await act(async () => { row(PANE_CODEX).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); });
    await act(async () => { ([...host.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent === 'Stop') as HTMLButtonElement).click(); await Promise.resolve(); });
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('This phone may not stop this agent.');
  });
});

describe('P18: the connection line', () => {
  it('says nothing while connected, and one plain line for each trouble', async () => {
    await render(<PhoneLinkLine kind="connected" recovered={false} />);
    expect(host.querySelector('[data-testid="phone-link-line"]')).toBeNull();
    const words: Array<[Parameters<typeof PhoneLinkLine>[0]['kind'], string]> = [
      ['reconnecting', 'Reconnecting…'],
      ['asleep', 'Your PC is asleep, or Potato Workspace is closed.'],
      ['offline', 'No internet on this phone.'],
      ['changed', 'The link changed. Pair this phone again.'],
    ];
    for (const [kind, line] of words) {
      await render(<PhoneLinkLine kind={kind} recovered={false} />);
      expect(host.querySelector('[data-testid="phone-link-line"]')?.textContent).toContain(line);
    }
  });

  it('shows Connected for a moment after a trouble ended', async () => {
    await render(<PhoneLinkLine kind="connected" recovered />);
    expect(host.querySelector('[data-testid="phone-link-line"]')?.textContent).toBe('Connected');
  });

  it('a changed link offers Pair again', async () => {
    const onPairAgain = vi.fn();
    await render(<PhoneLinkLine kind="changed" recovered={false} onPairAgain={onPairAgain} />);
    await act(async () => { (host.querySelector('.ph-link-btn') as HTMLButtonElement).click(); });
    expect(onPairAgain).toHaveBeenCalled();
  });
});

describe('P8: the back arrow after a jump', () => {
  it('the header shows a back arrow with the chat to go back to', async () => {
    const go = vi.fn();
    await render(<PhoneHeader title="Fix login" stateWords={null} waiting={0} bridgeReady onMenu={() => undefined} onNew={() => undefined} onBack={{ label: 'Billing tests', go }} />);
    const back = host.querySelector('[data-testid="phone-back"]') as HTMLButtonElement;
    expect(back.getAttribute('aria-label')).toBe('Back to Billing tests');
    await act(async () => back.click());
    expect(go).toHaveBeenCalled();
  });
});

describe('P19: three steps after pairing', () => {
  const env = (over: Partial<PushEnv> = {}): PushEnv => ({ hasServiceWorker: true, hasPushManager: true, hasNotification: true, isIOS: false, isStandalone: false, ...over });
  const deps = (over: Partial<PushDeps> = {}): PushDeps => ({
    permission: () => 'default',
    requestPermission: vi.fn(async () => 'granted' as NotificationPermission),
    isSubscribed: async () => false,
    subscribe: vi.fn(async () => ({ endpoint: 'https://push.test/x', keys: { p256dh: 'a', auth: 'b' } })),
    unsubscribe: async () => undefined,
    fetchKey: async () => 'key',
    sendSubscription: vi.fn(async () => undefined),
    removeSubscription: async () => undefined,
    ...over,
  });
  const steps = () => [...host.querySelectorAll('[data-testid="phone-setup"] > li')];

  it('has three steps and shows iPhone help on an iPhone', async () => {
    await render(<PhoneSetupSteps baseUrl="http://x" onDone={() => undefined} deps={deps()} env={env({ isIOS: true })} platform="ios" />);
    expect(steps()).toHaveLength(3);
    expect(steps()[0].textContent).toContain('Tap the Share button in Safari');
  });

  it('shows Android help on Android, and Done when it already runs from the Home Screen', async () => {
    await render(<PhoneSetupSteps baseUrl="http://x" onDone={() => undefined} deps={deps()} env={env()} platform="android" />);
    expect(steps()[0].textContent).toContain('Install app or Add to Home screen');
    await render(<PhoneSetupSteps baseUrl="http://x" onDone={() => undefined} deps={deps()} env={env({ isStandalone: true })} platform="android" />);
    expect(steps()[0].getAttribute('data-done')).toBe('true');
  });

  it('Allow notifications asks the browser and sends the subscription to the PC', async () => {
    const d = deps();
    await render(<PhoneSetupSteps baseUrl="http://x" onDone={() => undefined} deps={d} env={env()} platform="android" />);
    await act(async () => { ([...host.querySelectorAll('button')].find((b) => b.textContent === 'Allow notifications') as HTMLButtonElement).click(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(d.requestPermission).toHaveBeenCalled();
    expect(d.sendSubscription).toHaveBeenCalled();
    expect(steps()[1].getAttribute('data-done')).toBe('true');
  });

  it('on an iPhone that is not on the Home Screen yet, notifications wait for step 1', async () => {
    await render(<PhoneSetupSteps baseUrl="http://x" onDone={() => undefined} deps={deps()} env={env({ isIOS: true })} platform="ios" />);
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Allow notifications') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(steps()[1].textContent).toContain('do step 1 first');
  });

  it('the test button shows a notification and says so', async () => {
    const sendTest = vi.fn(async () => 'sent' as const);
    await render(<PhoneSetupSteps baseUrl="http://x" onDone={() => undefined} deps={deps()} env={env()} platform="android" sendTest={sendTest} />);
    await act(async () => { ([...host.querySelectorAll('button')].find((b) => b.textContent === 'Send a test notification') as HTMLButtonElement).click(); await Promise.resolve(); });
    expect(sendTest).toHaveBeenCalled();
    expect(steps()[2].textContent).toContain('Sent. Did you see it?');
  });

  it('Done closes it', async () => {
    const onDone = vi.fn();
    await render(<PhoneSetupSteps baseUrl="http://x" onDone={onDone} deps={deps()} env={env()} platform="android" />);
    await act(async () => { ([...host.querySelectorAll('button')].find((b) => b.className.includes('ph-step-done')) as HTMLButtonElement).click(); });
    expect(onDone).toHaveBeenCalled();
  });
});

describe('P19: Help in the phone settings', () => {
  const menu = (over: Partial<React.ComponentProps<typeof MenuSheet>> = {}) => (
    <MenuSheet
      onClose={() => undefined}
      bridgeUrl="http://x"
      bridgeReady
      settings={DEFAULT_PUBLIC_SETTINGS}
      onPatchSettings={() => undefined}
      link={null}
      echo={null}
      activeLabel={null}
      onCloseActive={() => undefined}
      onEditConnection={() => undefined}
      {...over}
    />
  );

  it('lists the last connection events, newest first, with a time', async () => {
    await render(menu({ linkEvents: [{ at: 1_700_000_000_000, kind: 'asleep' }, { at: 1_700_000_100_000, kind: 'connected' }] }));
    const items = [...host.querySelectorAll('[data-testid="phone-link-events"] li')];
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain('Connected');
    expect(items[1].textContent).toContain('Your PC is asleep');
    expect(host.querySelector('time')?.textContent).toMatch(/\d/);
  });

  it('Send a test notification runs the test and shows what happened', async () => {
    const onTestNotification = vi.fn(async () => 'Sent. Did you see it?');
    await render(menu({ linkEvents: [], onTestNotification }));
    await act(async () => { (host.querySelector('[data-testid="phone-test-push"]') as HTMLButtonElement).click(); await Promise.resolve(); });
    expect(onTestNotification).toHaveBeenCalled();
    expect(host.textContent).toContain('Sent. Did you see it?');
  });

  it('opens the setup steps again', async () => {
    const onOpenSetup = vi.fn();
    await render(menu({ onOpenSetup }));
    await act(async () => { ([...host.querySelectorAll('button')].find((b) => b.textContent === 'Set up this phone again') as HTMLButtonElement).click(); });
    expect(onOpenSetup).toHaveBeenCalled();
  });
});

describe('P20: the notice on the PC', () => {
  const ask = { id: 'ask-1', device_id: 'd1', device_name: 'Ren phone', pane_id: PANE_CODEX, at_ms: 1 };
  beforeEach(() => {
    tauriMock.asks = [];
    tauriMock.listeners.length = 0;
    tauriMock.answer.mockClear();
  });

  it('shows "<phone> asks for control" with Allow 15 min and No when an ask comes in', async () => {
    await render(<ControlAskNotice names={new Map([[PANE_CODEX, 'Billing tests']])} />);
    expect(host.querySelector('[data-testid="control-ask-notice"]')).toBeNull();
    await act(async () => { tauriMock.listeners.forEach((cb) => cb(ask)); });
    const notice = host.querySelector('[data-testid="control-ask-notice"]')!;
    expect(notice.textContent).toContain('Ren phone asks for control');
    expect(notice.textContent).toContain('Billing tests');
    expect([...notice.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['No', 'Allow 15 min']);
  });

  it('Allow 15 min allows, No says no, and the notice goes', async () => {
    tauriMock.asks = [ask];
    await render(<ControlAskNotice names={new Map()} />);
    await act(async () => { await Promise.resolve(); });
    await act(async () => { ([...host.querySelectorAll('button')].find((b) => b.textContent === 'Allow 15 min') as HTMLButtonElement).click(); });
    expect(tauriMock.answer).toHaveBeenCalledWith('ask-1', true);
    expect(host.querySelector('[data-testid="control-ask-notice"]')).toBeNull();
  });

  it('No sends allow = false', async () => {
    tauriMock.asks = [ask];
    await render(<ControlAskNotice names={new Map()} />);
    await act(async () => { await Promise.resolve(); });
    await act(async () => { ([...host.querySelectorAll('button')].find((b) => b.textContent === 'No') as HTMLButtonElement).click(); });
    expect(tauriMock.answer).toHaveBeenCalledWith('ask-1', false);
  });
});
