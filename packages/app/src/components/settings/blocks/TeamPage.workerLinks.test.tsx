// @vitest-environment jsdom
// Settings > Team with the one Potato Worker: the one-time invite link (made, shown, opened as a "Join?" popup,
// burned on first use by the Worker) and the "Use <address>" / "Update your Worker" offers. Rendered through the
// real TeamPage, so the screens ship wired in.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { teamConfig } from '../../../dev/team-fixtures';
import { JOIN_LINK_EVENT } from '../../../lib/join-link';
import type { InviteLookup, InviteView, TeamApi, TeamConfigView } from '../../../lib/team';
import { WORKER_UPDATE_COMMAND, type WorkerHealth } from '../../../lib/worker';
import { buttonByText, click, hasText, settle, type as typeInto } from '../test-utils';
import { TeamPage } from './TeamPage';

vi.mock('qrcode', () => ({ default: { toCanvas: vi.fn(async () => undefined) } }));

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
});

const NOT_ON_TEAM: Partial<TeamConfigView> = { enabled: false, team: '', teamName: '', relay: '', name: '', members: [], joins: [], admin: false, transport: null, link: null };
const LINK = 'https://pm-relay.maya.workers.dev/join/ABCDEFGH23456789';
const LOOK: InviteLookup = { host: 'pm-relay.maya.workers.dev', teamName: 'Acme crew', inviter: 'Maya', expiresAtMs: Date.now() + 3_600_000 };

function fakeApi(view: TeamConfigView, extra: Partial<TeamApi> = {}) {
  const calls: string[] = [];
  const api = {
    calls,
    configGet: async () => view,
    defaultName: async () => 'Pat',
    configSet: async () => view,
    create: async () => view,
    invite: async (): Promise<InviteView> => ({ link: 'pm://team/join?t=Acme&k=abc', code: 'KQ7M-4XPD', expiresAtMs: Date.now() + 86_400_000 }),
    join: async () => view,
    leave: async () => view,
    approveJoin: async () => view,
    declineJoin: async () => view,
    removeMember: async () => view,
    confirmGithub: async () => view,
    deployRelay: async () => ({ status: 'done', url: 'https://x.workers.dev' }) as const,
    onRelayDeployStep: async () => () => {},
    onChanged: async () => () => {},
    inviteLookup: async (link: string) => {
      calls.push(`lookup(${link})`);
      return LOOK;
    },
    inviteAccept: async (input: { link: string; name: string }) => {
      calls.push(`accept(${JSON.stringify(input)})`);
      return view;
    },
    ...extra,
  };
  return api as typeof api & TeamApi;
}

async function mount(view: TeamConfigView, extra: Partial<TeamApi> = {}, workers?: React.ComponentProps<typeof TeamPage>['workers']) {
  const api = fakeApi(view, extra);
  await act(async () => root.render(<TeamPage api={api} workers={workers} />));
  await settle(5);
  return api;
}

const dialog = () => host.querySelector('[data-testid="join-popup"]');
const buttonStarting = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith(text));
const pasteBox = () => host.querySelector<HTMLTextAreaElement>('textarea')!;

describe('Join through a one-time link', () => {
  it('pasting the link offers to look at it, the popup says who and what, and Join uses it once', async () => {
    const api = await mount(teamConfig(NOT_ON_TEAM));
    await click(buttonStarting('Join a team'));
    await typeInto(pasteBox(), `Join my team: ${LINK} .`);
    expect(host.querySelector('[data-testid="join-link-found"]')).not.toBeNull();
    expect(dialog()).toBeNull();
    expect(api.calls).toEqual([]); // nothing asked of the network until the person opens it

    await click(buttonByText(host, 'Look at this invite'));
    await settle(3);
    expect(api.calls).toEqual([`lookup(${LINK})`]);
    const popup = dialog()!;
    expect(popup.textContent).toContain('Join Acme crew?');
    expect(popup.textContent).toContain('Maya invited you.');
    expect(popup.textContent).toContain('Joining shares your name');
    expect(popup.textContent).toContain('The team owner still has to say yes');
    expect(popup.querySelector('[data-testid="join-host"]')!.textContent).toContain('pm-relay.maya.workers.dev');
    expect(api.calls.some((c) => c.startsWith('accept'))).toBe(false); // looking did not use it up

    await click([...popup.querySelectorAll('button')].find((b) => b.textContent === 'Join'));
    await settle(3);
    expect(api.calls[1]).toBe(`accept({"link":"${LINK}","name":"Pat"})`);
    expect(dialog()!.textContent).toContain('Asked Maya to let you into Acme crew');
  });

  it('Not now closes it and does not use the invite', async () => {
    const api = await mount(teamConfig(NOT_ON_TEAM));
    await click(buttonStarting('Join a team'));
    await typeInto(pasteBox(), LINK);
    await click(buttonByText(host, 'Look at this invite'));
    await settle(3);
    await click([...dialog()!.querySelectorAll('button')].find((b) => b.textContent === 'Not now'));
    expect(dialog()).toBeNull();
    expect(api.calls.some((c) => c.startsWith('accept'))).toBe(false);
  });

  it('a used or expired invite is said plainly and offers nothing to press but Close', async () => {
    await mount(teamConfig(NOT_ON_TEAM), {
      inviteLookup: async () => {
        throw new Error('This invite was already used. Ask for a new one.');
      },
    });
    await click(buttonStarting('Join a team'));
    await typeInto(pasteBox(), LINK);
    await click(buttonByText(host, 'Look at this invite'));
    await settle(3);
    expect(dialog()!.textContent).toContain('already used');
    expect([...dialog()!.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Close']);
  });

  it('a delivered deep link opens the popup; junk delivered the same way is dropped before any request', async () => {
    const api = await mount(teamConfig(NOT_ON_TEAM));
    const send = (detail: unknown) => act(async () => void window.dispatchEvent(new CustomEvent(JOIN_LINK_EVENT, { detail })));
    for (const junk of ['potato-workspace://join/ABCDEFGH23456789?w=localhost', 'potato-workspace://join/x?w=a.dev', 'javascript:alert(1)', 5, null, '']) {
      await send(junk);
    }
    await settle(2);
    expect(dialog()).toBeNull();
    expect(api.calls).toEqual([]);

    await send('potato-workspace://join/abcdefgh23456789?w=Pm-Relay.Maya.workers.dev');
    await settle(3);
    expect(api.calls).toEqual([`lookup(${LINK})`]);
    expect(dialog()!.textContent).toContain('Join Acme crew?');
  });

  it('a desktop without link support says to update instead of failing', async () => {
    await mount(teamConfig(NOT_ON_TEAM), { inviteLookup: undefined, inviteAccept: undefined });
    await click(buttonStarting('Join a team'));
    await typeInto(pasteBox(), LINK);
    await click(buttonByText(host, 'Look at this invite'));
    await settle(2);
    expect(dialog()!.textContent).toContain('Update Potato Workspace');
  });
});

describe('Make an invite on a Potato Worker', () => {
  it('shows the one-time link first, with the older link and code folded behind it', async () => {
    const joinUrl = 'https://pm-relay.maya.workers.dev/join/ABCDEFGH23456789';
    await mount(teamConfig(), {
      invite: async () => ({ link: 'pm://team/join?t=Acme&k=abc', code: 'KQ7M-4XPD', expiresAtMs: Date.now() + 86_400_000, joinUrl }),
    });
    await click(buttonStarting('Make an invite') ?? buttonByText(host, 'Make an invite'));
    await settle(3);
    const field = host.querySelector<HTMLInputElement>('[data-testid="invite-join-url"]')!;
    expect(field.value).toBe(joinUrl);
    expect(hasText(host, 'It works once, for 24 hours.')).toBe(true);
    const older = host.querySelector('details.tp-older')!;
    expect(older.textContent).toContain('KQ7M-4XPD');
    expect(older.hasAttribute('open')).toBe(false);
  });

  it('an older Worker gets the pasted invite and the one update command', async () => {
    await mount(teamConfig(), {
      invite: async () => ({ link: 'pm://team/join?t=Acme&k=abc', code: 'KQ7M-4XPD', expiresAtMs: Date.now() + 600_000, joinUrlNote: 'update-worker' }),
    });
    await click(buttonStarting('Make an invite') ?? buttonByText(host, 'Make an invite'));
    await settle(3);
    expect(host.querySelector('[data-testid="invite-join-url"]')).toBeNull();
    expect(hasText(host, 'KQ7M-4XPD')).toBe(true);
    expect(host.querySelector('[data-testid="invite-update-worker"]')!.textContent).toContain(WORKER_UPDATE_COMMAND);
  });
});

describe('One Worker for the relay and the phone link', () => {
  const withFeatures = (features: string[], reachable = true) => async (): Promise<WorkerHealth> => ({ reachable, features, legacyLink: false });
  const openStart = async (workers: NonNullable<React.ComponentProps<typeof TeamPage>['workers']>) => {
    await mount(teamConfig(NOT_ON_TEAM), {}, workers);
    await click(buttonStarting('Start a team'));
    await click(buttonStarting('Other ways'));
    await click(buttonStarting('Use my own address'));
    await settle(3);
  };
  const relayField = () => host.querySelector<HTMLInputElement>('input[placeholder="https://relay.example.com"]')!;

  it('Start a team offers the phone link Worker when it can be a relay, and fills the address on one click', async () => {
    await openStart({ savedLink: async () => 'https://potato-link.maya.workers.dev', check: withFeatures(['team', 'stable-link']) });
    const offer = host.querySelector('[data-testid="stable-relay-suggestion"]')!;
    expect(offer.textContent).toContain('Use https://potato-link.maya.workers.dev (your phone link Worker)');
    await click(offer.querySelector('button'));
    expect(relayField().value).toBe('https://potato-link.maya.workers.dev');
    expect(host.querySelector('[data-testid="stable-relay-suggestion"]')).toBeNull(); // already in use
  });

  it('an older Worker without the team part says "Update your Worker" with the command, and offers nothing to use', async () => {
    await openStart({ savedLink: async () => 'https://potato-link.maya.workers.dev', check: withFeatures(['stable-link']) });
    expect(host.querySelector('[data-testid="stable-relay-suggestion"]')).toBeNull();
    const update = host.querySelector('[data-testid="worker-update"]')!;
    expect(update.textContent).toContain('Update your Worker');
    expect(update.textContent).toContain(WORKER_UPDATE_COMMAND);
    expect(relayField().value).toBe('');
  });

  it('an address that does not answer is not offered', async () => {
    await openStart({ savedLink: async () => 'https://potato-link.maya.workers.dev', check: withFeatures([], false) });
    expect(host.querySelector('[data-testid="stable-relay-suggestion"]')).toBeNull();
    expect(host.querySelector('[data-testid="worker-unreachable"]')!.textContent).toContain("Can't reach https://potato-link.maya.workers.dev");
  });

  it('no saved phone link Worker: nothing is offered', async () => {
    await openStart({ savedLink: async () => null, check: withFeatures(['team']) });
    expect(host.querySelector('[data-testid="stable-relay-suggestion"]')).toBeNull();
    expect(host.querySelector('[data-testid="worker-update"]')).toBeNull();
  });
});
