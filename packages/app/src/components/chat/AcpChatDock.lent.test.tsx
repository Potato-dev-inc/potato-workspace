// @vitest-environment jsdom
// A chat on a sign-in lent by my other PC ("Use my own agents"), as the dock under it shows it.
//   On the PC that runs the agent: the lender does not answer -> "Paused: <PC>, the PC with your sign-in, is offline." and Continue (the same ordinary
//   message as after a closed app). Never the far agent's own sign-in card: there is nothing to sign in on that PC.
//   On the lender's screen: the sign-in that ended is THIS PC's, said so, with nothing that would sign in the other PC.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitApi } from '../../hooks/useCockpit';
import { GRANT_IN_PANE, GRANT_OUT, lendState } from '../../dev/lend-fixtures';
import { setLanguagePref } from '../../i18n';
import type { AcpChatApi, AcpChatState } from '../../lib/acpChat';
import { fakeAcpApi } from '../../lib/acpChatFake';
import type { Grant } from '../../lib/lend';

let grants: Grant[] = [];
vi.mock('../lend/useLend', () => ({
  useLend: () => ({ state: lendState({ grants }), enabled: true, known: true, now: Date.now(), refresh: () => undefined }),
}));

import { AcpChatDock } from './AcpChatDock';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = (over: Partial<AcpChatState> = {}): AcpChatState => ({
  lane: 'acp', agent: 'claude', label: 'Claude', phase: 'idle', status: 'idle', turnInFlight: false, stopping: false, canSteer: false, turn: 1, title: null, usage: null, permissions: [], closed: false, ...over,
});

const inGrant = (over: Partial<Grant> = {}): Grant => ({ ...GRANT_IN_PANE, peer_node: 'bb', pane_ids: ['p1'], peer_device_name: 'Desk PC', ends_ms: Date.now() + 3600_000, ...over });

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
  grants = [];
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setLanguagePref('en', false);
});

const c = { now: 5, asked: { questions: [], answerQuestion: vi.fn(), dismissQuestion: vi.fn() }, newAgent: vi.fn(), launchEntries: [], registry: { panes: new Map() } } as unknown as CockpitApi;
const strip = (id: string) => host.querySelector(`[data-testid="${id}"]`);
const continueButton = () => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Continue');

async function mount(api: AcpChatApi) {
  await act(async () => root.render(<AcpChatDock c={c} paneId="p1" paneName="Claude" api={api} />));
  await act(async () => {});
}

describe('a chat on my own lent sign-in', () => {
  it('says Paused when the lending PC does not answer, and Continue sends the ordinary message', async () => {
    grants = [inGrant({ problem: 'not answering', problem_kind: 'unreachable' })];
    const continueTurn = vi.fn(async () => undefined);
    await mount(fakeAcpApi({ state: async () => state(), continueTurn }));
    expect(strip('acp-paused')!.textContent).toContain('Paused: Desk PC, the PC with your sign-in, is offline.');
    await act(async () => continueButton()!.click());
    expect(continueTurn).toHaveBeenCalledWith('p1');
  });

  it('shows nothing while the lend answers, on a chat that is not on a lend, and on the lender screen', async () => {
    for (const list of [[inGrant()], [], [{ ...GRANT_OUT, peer_node: 'aa', pane_ids: ['p1'], ends_ms: Date.now() + 3600_000, problem: 'x', problem_kind: 'unreachable' as const }]]) {
      grants = list;
      await mount(fakeAcpApi({ state: async () => state() }));
      expect(strip('acp-paused')).toBeNull();
    }
  });

  it('has no Continue while a turn runs (Stop is in the message box)', async () => {
    grants = [inGrant({ problem: 'not answering', problem_kind: 'unreachable' })];
    await mount(fakeAcpApi({ state: async () => state({ turnInFlight: true, phase: 'working', status: 'running' }), continueTurn: async () => undefined }));
    expect(strip('acp-paused')).not.toBeNull();
    expect(continueButton()).toBeUndefined();
  });

  it("a teammate's lend, or a lend that is over, is not shown as Paused; an ended one still names whose sign-in it was", async () => {
    // A teammate lent it (no PC of mine on the other side): none of the "your sign-in" words.
    grants = [inGrant({ peer_node: undefined, problem: 'not answering', problem_kind: 'unreachable' })];
    await mount(fakeAcpApi({ state: async () => state({ signIn: { needed: true, hint: 'Type /login.' } }) }));
    expect(strip('acp-paused')).toBeNull();
    expect(strip('acp-lent-signin')).toBeNull();
    // Over: no Paused strip (nothing to wait for), but the sign-in line still says the lent sign-in ended.
    grants = [inGrant({ state: 'ended', end_reason: 'expired', ends_ms: Date.now() - 1000, problem: 'not answering', problem_kind: 'unreachable' })];
    await mount(fakeAcpApi({ state: async () => state({ signIn: { needed: true, hint: 'Type /login.' } }) }));
    expect(strip('acp-paused')).toBeNull();
    expect(strip('acp-lent-signin')!.textContent).toContain('The sign-in lent by Desk PC ended.');
  });

  it('is worded in Traditional Chinese too', async () => {
    setLanguagePref('zh-TW', false);
    grants = [inGrant({ problem: 'not answering', problem_kind: 'unreachable' })];
    await mount(fakeAcpApi({ state: async () => state(), continueTurn: async () => undefined }));
    expect(strip('acp-paused')!.textContent).toContain('已暫停');
    expect(continueButton()).toBeUndefined();
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === '繼續')).toBe(true);
  });

  it('a sign-in that is needed is the lender\'s: no sign-in card for the far agent, one line saying whose', async () => {
    grants = [inGrant()];
    await mount(fakeAcpApi({ state: async () => state({ signIn: { needed: true, hint: 'Type /login.' } }) }));
    expect(strip('signin-fix-card')).toBeNull();
    expect(strip('acp-lent-signin')!.textContent).toBe('The sign-in lent by Desk PC ended. Sign in again on Desk PC, then try again.');
  });

  it('on the lender screen the sign-in that ended is this PC\'s', async () => {
    grants = [{ ...GRANT_OUT, peer_node: 'aa', pane_ids: ['p1'], ends_ms: Date.now() + 3600_000 }];
    await mount(fakeAcpApi({ state: async () => state({ signIn: { needed: true, hint: 'Type /login.' } }) }));
    expect(strip('signin-fix-card')).toBeNull();
    expect(strip('acp-lent-signin')!.textContent).toBe('Your sign-in on this PC ended. Sign in again, then try again.');
  });
});
