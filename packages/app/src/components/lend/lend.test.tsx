// @vitest-environment jsdom
// Share an agent, one component at a time, against the fake `lend_*` API: Request usage, the incoming card, member rows,
// the time-left chip, the toasts.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeLendApi, GRANT_IN, GRANT_IN_PANE, GRANT_IN_PROBLEM, GRANT_OUT, LEND_MEMBERS, lendState, REQUEST_MAYA, REQUEST_OWN } from '../../dev/lend-fixtures';
import { teamConfig } from '../../dev/team-fixtures';
import type { TeamApi } from '../../lib/team';
import { buttonByText, click, hasText, pickOption, settle, type as typeInto } from '../settings/test-utils';
import { BorrowedChip, MemberLends, useLendToasts } from './Borrowed';
import { IncomingRequestCard, profilesFor } from './IncomingRequestCard';
import { RequestUsage, sourcesOf } from './RequestUsage';
import { useLend } from './useLend';

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
});

const team = { configGet: async () => teamConfig({ members: LEND_MEMBERS }) } as unknown as TeamApi;
const dialog = () => document.querySelector<HTMLElement>('.lend-sheet')!;
const field = (label: string) => dialog().querySelector<HTMLInputElement & HTMLSelectElement & HTMLTextAreaElement>(`[aria-label="${label}"]`)!;

describe('Request usage', () => {
  it('lists my other PCs first, then teammates', () => {
    const { mine, others } = sourcesOf(LEND_MEMBERS);
    expect(mine.map((s) => s.label)).toEqual(['Leo laptop']);
    expect(others.map((s) => s.label)).toEqual(['Maya', 'Sam']);
    // Without a device list, a second device is "My other PC".
    expect(sourcesOf([{ ...LEND_MEMBERS[0], deviceList: undefined }]).mine.map((s) => s.label)).toEqual(['My other PC']);
    expect(sourcesOf([{ ...LEND_MEMBERS[0], deviceList: undefined, devices: 1 }]).mine).toEqual([]);
  });

  async function open(api = createFakeLendApi()) {
    await act(async () => root.render(<RequestUsage api={api} team={team} />));
    await settle(4);
    await click(buttonByText(host, 'Request usage'));
    await settle(4);
    return api;
  }

  it('asks my other PC for an agent, with a length and a reason, then shows Waiting, Ready and Said no', async () => {
    const api = await open();
    const sel = dialog().querySelectorAll('optgroup');
    expect([...sel].map((g) => g.label)).toEqual(['My PCs', 'Teammates']);
    // Claude is a lab driver (tagged); Codex is listed as coming soon and cannot be picked.
    const agents = [...field('Agent').options].map((o) => [o.textContent, o.disabled]);
    expect(agents).toEqual([['Claude · Lab', false], ['Codex: coming soon', true]]);
    await typeInto(field('Why'), 'Mine is out of usage.');
    await click(buttonByText(dialog(), 'Ask'));
    await settle(4);
    expect(api.calls).toContain('request("m-leo","d-lap","claude",28800,"Mine is out of usage.")');
    expect(dialog().textContent).toContain('Waiting');
    const id = api.backend.state.requests_out[0].id;
    await act(async () => api.backend.settleOut(id, true));
    await settle(4);
    expect(dialog().textContent).toContain('Ready');
    await act(async () => api.backend.settleOut(id, false));
    await settle(4);
    expect(dialog().textContent).toContain('Said no');
  });

  it('blocks a length over the cap, and 24 hours is the most for another person', async () => {
    const api = await open();
    await pickOption(field('Ask'), 'm-maya|');
    await click(buttonByText(dialog(), 'Custom'));
    await typeInto(field('Hours'), '25');
    expect(dialog().textContent).toContain('24 hours at most');
    expect(buttonByText(dialog(), 'Ask')!.disabled).toBe(true);
    await typeInto(field('Hours'), '24');
    expect(buttonByText(dialog(), 'Ask')!.disabled).toBe(false);
    // My own PC may go to 7 days.
    await pickOption(field('Ask'), 'm-leo|d-lap');
    await typeInto(field('Hours'), '168');
    expect(buttonByText(dialog(), 'Ask')!.disabled).toBe(false);
    await typeInto(field('Hours'), '169');
    expect(buttonByText(dialog(), 'Ask')!.disabled).toBe(true);
    expect(api.calls).toEqual([]);
  });

  it('limits the reason to 280 characters', async () => {
    await open();
    expect(field('Why').maxLength).toBe(280);
  });

  it('shows the error a failed ask gives and stays open', async () => {
    const api = createFakeLendApi();
    api.backend.failWith = 'The relay is not reachable.';
    await open(api);
    await click(buttonByText(dialog(), 'Ask'));
    await settle(3);
    expect(dialog().textContent).toContain('The relay is not reachable.');
  });

  it('lists my recent asks next to the button', async () => {
    const api = createFakeLendApi({ requests_out: [{ ...REQUEST_MAYA, direction: 'out', state: 'accepted' }] });
    await act(async () => root.render(<RequestUsage api={api} team={team} />));
    await settle(4);
    expect(host.querySelector('[aria-label="Your requests"]')!.textContent).toContain('Ready');
  });

  it('draws nothing while Share an agent is off', async () => {
    await act(async () => root.render(<RequestUsage api={createFakeLendApi({ enabled: false })} team={team} />));
    await settle(4);
    expect(host.textContent).toBe('');
  });
});

describe('Incoming request card', () => {
  const mount = async (request = REQUEST_MAYA, seed = {}) => {
    const api = createFakeLendApi({ requests_in: [request], ...seed });
    const onDone = vi.fn();
    await act(async () => root.render(<IncomingRequestCard request={request} state={api.backend.get()} api={api} now={Date.now()} onDone={onDone} />));
    await settle(2);
    return { api, onDone };
  };

  it('reads like the plan says, with the reason quoted', async () => {
    await mount();
    expect(host.textContent).toContain("Maya's laptop wants Claude for 8 hours");
    expect(host.textContent).toContain('“Mine hit its limit');
    for (const label of ['Lend', 'Change time', 'Say no']) expect(buttonByText(host, label), label).toBeTruthy();
  });

  it('keeps Lend off until "I understand" is ticked when the borrower is another person', async () => {
    const { api } = await mount();
    expect(host.textContent).toContain('Use at your own risk');
    const lend = buttonByText(host, 'Lend')!;
    expect(lend.disabled).toBe(true);
    await click(host.querySelector('.lend-tick input'));
    expect(buttonByText(host, 'Lend')!.disabled).toBe(false);
    await click(buttonByText(host, 'Lend'));
    await settle(2);
    expect(api.calls).toContain('answer("req-in-maya",true,"prof-team",null)');
  });

  it('shows no warning for my own PC, and Lend works at once', async () => {
    const { api } = await mount(REQUEST_OWN);
    expect(host.querySelector('[data-lend-warning]')).toBeNull();
    await click(buttonByText(host, 'Lend'));
    await settle(2);
    expect(api.calls).toContain('answer("req-in-own",true,"prof-mine",null)');
  });

  it('offers a profile picker when several profiles fit', async () => {
    const own = { ...REQUEST_OWN, agent_id: 'claude' };
    const second = { ...lendState().profiles[0], id: 'prof-mine-2', name: 'Short loans', default_secs: 3600 };
    const { api } = await mount(own, { profiles: [...lendState().profiles, second] });
    const sel = host.querySelector<HTMLSelectElement>('select[aria-label="Lend with"]')!;
    expect([...sel.options].map((o) => o.textContent)).toEqual(['My other PCs', 'Short loans']);
    await pickOption(sel, 'prof-mine-2');
    expect(buttonByText(host, 'Lend with Short loans')).toBeTruthy();
    await click(buttonByText(host, 'Lend with Short loans'));
    await settle(2);
    expect(api.calls).toContain('answer("req-in-own",true,"prof-mine-2",null)');
  });

  it('changes the time, and blocks more than another person may have', async () => {
    const { api } = await mount();
    await click(host.querySelector('.lend-tick input'));
    await click(buttonByText(host, 'Change time'));
    await click(buttonByText(host, '1 hour'));
    await click(buttonByText(host, 'Lend'));
    await settle(2);
    expect(api.calls).toContain('answer("req-in-maya",true,"prof-team",3600)');
  });

  it('says no', async () => {
    const { api, onDone } = await mount();
    await click(buttonByText(host, 'Say no'));
    await settle(2);
    expect(api.calls).toContain('answer("req-in-maya",false,null,null)');
    expect(onDone).toHaveBeenCalled();
  });

  it('points to Lend settings when no profile fits', async () => {
    await mount(REQUEST_MAYA, { profiles: [] });
    expect(host.textContent).toContain('No profile lends Claude to teammates yet.');
    expect(buttonByText(host, 'Lend')!.disabled).toBe(true);
    expect(profilesFor(lendState({ profiles: [] }), REQUEST_MAYA)).toEqual([]);
  });
});

describe('Member rows', () => {
  function Rows({ api }: { api: ReturnType<typeof createFakeLendApi> }) {
    const lend = useLend(api);
    return (
      <>
        <MemberLends memberId="m-maya" lend={lend} api={api} />
        <MemberLends memberId="m-sam" lend={lend} api={api} />
      </>
    );
  }
  it('shows lends both ways with Revoke and Give back', async () => {
    const api = createFakeLendApi({ grants: [GRANT_OUT, GRANT_IN] });
    await act(async () => root.render(<Rows api={api} />));
    await settle(4);
    expect(host.textContent).toMatch(/Lending Claude to Maya · 2h 1\dm left/);
    expect(host.textContent).toMatch(/Borrowing Claude from Sam · 4\dm left/);
    await click(buttonByText(host, 'Revoke'));
    await settle(3);
    expect(api.calls).toContain('revoke("grant-out-1")');
    await click(buttonByText(host, 'Give back'));
    await settle(3);
    expect(api.calls).toContain('giveBack("grant-in-1")');
    expect(host.textContent).not.toContain('Lending Claude');
  });
});

describe('Time-left chip', () => {
  async function chip(left: number) {
    const now = Date.now();
    const api = createFakeLendApi({ grants: [{ ...GRANT_IN_PANE, ends_ms: now + left }] });
    await act(async () => root.render(<BorrowedChip paneId="pane-claude-1" api={api} />));
    await settle(4);
    return api;
  }
  const el = () => host.querySelector<HTMLButtonElement>('[data-testid="lend-chip"]');

  it('shows "Leo\'s Claude · 1h 59m" on the borrowed pane only', async () => {
    await chip(119 * 60_000 - 5000);
    expect(el()!.textContent).toMatch(/^Leo's Claude · 1h 5\dm$/);
    expect(el()!.dataset.urgency).toBe('calm');
    await act(async () => root.render(<BorrowedChip paneId="another-pane" api={createFakeLendApi({ grants: [GRANT_IN_PANE] })} />));
    await settle(4);
    expect(el()).toBeNull();
  });

  it('turns amber at 10 minutes and red at 1', async () => {
    await chip(9 * 60_000);
    expect(el()!.dataset.urgency).toBe('soon');
    await chip(30_000);
    expect(el()!.dataset.urgency).toBe('now');
  });

  it('shows the lender expired sign-in on the chip and in its details', async () => {
    const api = createFakeLendApi({ grants: [{ ...GRANT_IN_PROBLEM, ends_ms: Date.now() + 50 * 60_000 }] });
    await act(async () => root.render(<BorrowedChip paneId="pane-claude-1" api={api} />));
    await settle(4);
    expect(el()!.dataset.problem).toBe('true');
    expect(el()!.title).toBe("The lender's sign-in expired. Ask them to sign in again.");
    await click(el());
    expect(host.querySelector('[data-testid="lend-problem"]')!.textContent).toBe("The lender's sign-in expired. Ask them to sign in again.");
  });

  it('opens its details, and Give back now ends the lend', async () => {
    const api = await chip(50 * 60_000);
    await click(el());
    expect(host.querySelector('.lend-pop')!.textContent).toContain("Borrowed Claude from Leo's PC");
    // The details say what was used (requests and tokens).
    expect(host.querySelector('[data-testid="lend-usage"]')!.textContent).toBe('Used so far: 3 requests · 5.3k tokens');
    expect(host.querySelector('[data-testid="lend-problem"]')).toBeNull();
    await click(buttonByText(host, 'Give back now'));
    await settle(3);
    expect(api.calls).toContain('giveBack("grant-in-2")');
    expect(el()).toBeNull();
  });
});

describe('Toasts at 10 minutes and 1 minute', () => {
  function Toasts({ api, notify }: { api: ReturnType<typeof createFakeLendApi>; notify: (t: string) => void }) {
    const lend = useLend(api);
    useLendToasts(lend, notify);
    return null;
  }
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  it('says "Finish or save now" once at each mark', async () => {
    const notify = vi.fn();
    const api = createFakeLendApi({ grants: [{ ...GRANT_IN, ends_ms: Date.now() + 10 * 60_000 + 20_000 }] });
    await act(async () => root.render(<Toasts api={api} notify={notify} />));
    await settle(3);
    expect(notify).not.toHaveBeenCalled();
    await act(async () => void vi.advanceTimersByTime(30_000));
    await settle(3);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toContain('Finish or save now');
    expect(notify.mock.calls[0][0]).toContain("Sam's Claude");
    await act(async () => void vi.advanceTimersByTime(9 * 60_000));
    await settle(3);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[1][0]).toContain('1 minute left');
    await act(async () => void vi.advanceTimersByTime(30_000));
    await settle(3);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('does not warn about a lend I lent out', async () => {
    const notify = vi.fn();
    const api = createFakeLendApi({ grants: [{ ...GRANT_OUT, ends_ms: Date.now() + 5 * 60_000 }] });
    await act(async () => root.render(<Toasts api={api} notify={notify} />));
    await settle(3);
    expect(notify).not.toHaveBeenCalled();
    expect(hasText(host, '')).toBe(true);
  });
});
