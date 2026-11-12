// @vitest-environment jsdom
// Settings > Team: the two choices, Start (recommended relay first, other ways folded), Join (paste box), waiting,
// and the page of a team that exists (status, invite, waiting members, people, options, leave).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { teamConfig } from '../../../dev/team-fixtures';
import type { RelayDeployResult, RelayDeployStep, TeamApi, TeamConfigView } from '../../../lib/team';
import { buttonByText, click, hasText, settle, type as typeInto } from '../test-utils';
import { CLOUDFLARE_TOKENS_URL } from './RelaySheet';
import { connectionOf, RELAY_HELP_URL, TeamPage } from './TeamPage';

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
const INVITE = 'pm://team/join?v=1&t=team-7f3a&n=Acme&k=8Vh2mQ0pXn4c';
const JUST_ME = () => teamConfig({ joins: [], members: teamConfig().members.slice(0, 1) });

let stepListeners: ((step: RelayDeployStep) => void)[] = [];

function fakeApi(view: TeamConfigView) {
  stepListeners = [];
  const calls: string[] = [];
  const rec =
    <T,>(name: string, value: T) =>
    async (...args: unknown[]) => {
      calls.push(`${name}(${args.map((a) => JSON.stringify(a)).join(',')})`);
      return value;
    };
  const api = {
    calls,
    configGet: rec('configGet', view),
    defaultName: rec('defaultName', 'Pat'),
    configSet: rec('configSet', view),
    create: rec('create', JUST_ME()),
    invite: rec('invite', { link: 'pm://team/join?t=Acme&k=abc123', code: 'KQ7M-4XPD', expiresAtMs: Date.now() + 600_000 }),
    join: rec('join', teamConfig({ ...NOT_ON_TEAM, joining: 'Acme' })),
    leave: rec('leave', teamConfig(NOT_ON_TEAM)),
    approveJoin: rec('approveJoin', teamConfig({ joins: [] })),
    declineJoin: rec('declineJoin', teamConfig({ joins: [] })),
    removeMember: rec('removeMember', teamConfig()),
    confirmGithub: rec('confirmGithub', teamConfig()),
    deployRelay: rec<RelayDeployResult>('deployRelay', { status: 'done', url: 'https://pm-relay.maya.workers.dev' }),
    onRelayDeployStep: async (cb: (step: RelayDeployStep) => void) => {
      stepListeners.push(cb);
      return () => {};
    },
    onChanged: async () => () => {},
  };
  return api as typeof api & TeamApi;
}

async function mount(view: TeamConfigView, props: { displayName?: string } = {}) {
  const api = fakeApi(view);
  const onSaved = vi.fn();
  await act(async () => root.render(<TeamPage api={api} onSaved={onSaved} {...props} />));
  await settle(5);
  return { api, onSaved };
}

const input = (label: string) => host.querySelector<HTMLInputElement>(`input[aria-label="${label}"], textarea[aria-label="${label}"]`)!;
/** The input in the row whose label text is `label`. */
const field = (label: string) =>
  [...host.querySelectorAll('label')].find((l) => l.querySelector('span')?.textContent === label)?.querySelector('input, textarea') as HTMLInputElement;
const sheet = () => host.querySelector('.st-sheet');
const sheetButton = (text: string) => [...(sheet()?.querySelectorAll('button') ?? [])].find((b) => b.textContent?.trim() === text) as HTMLButtonElement;
const buttons = () => [...host.querySelectorAll('button')].map((b) => b.textContent?.trim());
const buttonStarting = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith(text));

describe('no team yet', () => {
  it('shows two big choices and nothing else', async () => {
    await mount(teamConfig(NOT_ON_TEAM));
    expect(buttons()).toEqual(['Start a teamBe the owner. Pick a name, connect, and send an invite.', 'Join a teamSomeone sent you an invite. Paste it here.']);
    expect(host.querySelectorAll('input, textarea')).toHaveLength(0);
    expect(hasText(host, 'Create team relay')).toBe(false);
  });

  it('Back returns to the two choices', async () => {
    await mount(teamConfig(NOT_ON_TEAM));
    await click(buttonStarting('Start a team'));
    expect(hasText(host, 'Team name')).toBe(true);
    await click(buttonByText(host, 'Back'));
    expect(hasText(host, 'Start a team')).toBe(true);
    expect(hasText(host, 'Team name')).toBe(false);
  });
});

describe('start a team', () => {
  const open = async (props: { displayName?: string } = {}) => {
    const m = await mount(teamConfig(NOT_ON_TEAM), props);
    await click(buttonStarting('Start a team'));
    return m;
  };

  it('asks for the team name and your name (already filled in), with the relay first and the other ways folded', async () => {
    await open();
    expect(field('Your name').value).toBe('Pat'); // this computer's name, until Settings has one
    const order = buttons();
    expect(order).toContain('Create team relay');
    expect(hasText(host, 'Recommended')).toBe(true);
    const other = buttonStarting('Other ways')!;
    expect(order.indexOf('Create team relay')).toBeLessThan(order.findIndex((t) => t?.startsWith('Other ways')));
    expect(other.getAttribute('aria-expanded')).toBe('false');
    expect(hasText(host, 'Use my own address')).toBe(false);
    expect(hasText(host, 'Use a shared folder')).toBe(false);
    expect(field('Relay address')).toBeUndefined();
    await click(other);
    expect(other.getAttribute('aria-expanded')).toBe('true');
    expect(hasText(host, 'Use my own address')).toBe(true);
    expect(hasText(host, 'Use a shared folder')).toBe(true);
  });

  it('the name in Settings wins over the computer name', async () => {
    await open({ displayName: 'Maya' });
    expect(field('Your name').value).toBe('Maya');
  });

  it('create team relay: one button deploys a relay with a pasted token, creates the team with it and shows the invite', async () => {
    const { api } = await open();
    expect(buttonByText(host, 'Create team relay')!.disabled).toBe(true);
    await typeInto(field('Team name'), 'Acme');
    await click(buttonByText(host, 'Create team relay'));
    // Three plain steps, with the Cloudflare link and the template named.
    const how = [...sheet()!.querySelectorAll('.st-relay-how li')].map((li) => li.textContent);
    expect(how).toHaveLength(3);
    expect(how[0]).toContain('Open Cloudflare');
    expect(how[1]).toContain('Edit Cloudflare Workers');
    expect(how[2]).toContain('Paste the token here');
    const link = [...sheet()!.querySelectorAll('a')].find((a) => a.textContent === 'Create a Cloudflare token') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe(CLOUDFLARE_TOKENS_URL);
    expect(sheetButton('Create relay').disabled).toBe(true);
    const token = sheet()!.querySelector<HTMLInputElement>('input[aria-label="Cloudflare token"]')!;
    expect(token.type).toBe('password');
    await typeInto(token, 'cf-token');
    await click(sheetButton('Create relay'));
    await settle(5);
    expect(api.calls).toContain('deployRelay("cf-token",null)');
    expect(api.calls.find((c) => c.startsWith('create'))).toBe('create({"teamName":"Acme","name":"Pat","relay":"https://pm-relay.maya.workers.dev","folder":""})');
    expect(host.querySelector('.st-relay')).toBeNull();
    // The new team's page: the invite is already made.
    expect(host.querySelector('.st-invite-code')!.textContent).toBe('KQ7M-4XPD');
    expect(hasText(host, 'Send this to your teammate')).toBe(true);
  });

  it('create team relay: shows the step it is on, and an error inline with Retry', async () => {
    const { api } = await open();
    let fail = true;
    api.deployRelay = async (...[t, a]: unknown[]): Promise<RelayDeployResult> => {
      api.calls.push(`deployRelay(${JSON.stringify(t)},${JSON.stringify(a)})`);
      stepListeners.forEach((cb) => cb('token'));
      stepListeners.forEach((cb) => cb('upload'));
      if (fail) throw new Error("That token can't edit Workers.");
      return { status: 'done', url: 'https://pm-relay.maya.workers.dev' };
    };
    await typeInto(field('Team name'), 'Acme');
    await click(buttonByText(host, 'Create team relay'));
    await typeInto(sheet()!.querySelector<HTMLInputElement>('input[aria-label="Cloudflare token"]')!, 'cf-token');
    await click(sheetButton('Create relay'));
    await settle(5);
    const steps = [...sheet()!.querySelectorAll('.st-relay-steps li')].map((li) => `${li.textContent}:${li.getAttribute('data-state')}`);
    expect(steps).toEqual([
      'Checking your token:done',
      'Putting the relay in your account:failed',
      'Turning on its free address:later',
      'Waiting for it to start:later',
      'Done:later',
    ]);
    expect(sheet()!.querySelector('.st-relay-now')!.textContent).toBe('Stopped at step 2 of 4');
    expect(sheet()!.querySelector('[role="alert"]')!.textContent).toBe("That token can't edit Workers.");
    expect(sheet()!.textContent).toContain('Check the token uses the “Edit Cloudflare Workers” template');
    expect(api.calls.some((c) => c.startsWith('create'))).toBe(false);
    fail = false;
    await click(sheetButton('Retry'));
    await settle(5);
    expect(api.calls.filter((c) => c.startsWith('deployRelay'))).toHaveLength(2);
    expect(api.calls.some((c) => c.startsWith('create'))).toBe(true);
  });

  it('create team relay: a token that sees several accounts asks which one', async () => {
    const { api } = await open();
    api.deployRelay = async (...[t, a]: unknown[]): Promise<RelayDeployResult> => {
      api.calls.push(`deployRelay(${JSON.stringify(t)},${JSON.stringify(a)})`);
      return a
        ? { status: 'done', url: 'https://pm-relay.work.workers.dev' }
        : {
            status: 'pick_account',
            accounts: [
              { id: 'a1', name: 'Maya' },
              { id: 'a2', name: 'Work' },
            ],
          };
    };
    await typeInto(field('Team name'), 'Acme');
    await click(buttonByText(host, 'Create team relay'));
    expect(sheet()!.querySelector('[aria-label="Cloudflare account"]')).toBeNull();
    await typeInto(sheet()!.querySelector<HTMLInputElement>('input[aria-label="Cloudflare token"]')!, 'cf-token');
    await click(sheetButton('Create relay'));
    await settle(5);
    expect(sheet()!.querySelector('[aria-label="Cloudflare account"]')).not.toBeNull();
    await click(sheetButton('Create relay'));
    await settle(5);
    expect(api.calls.filter((c) => c.startsWith('deployRelay'))).toEqual(['deployRelay("cf-token",null)', 'deployRelay("cf-token","a1")']);
    expect(api.calls.find((c) => c.startsWith('create'))).toContain('"relay":"https://pm-relay.work.workers.dev"');
  });

  it('other ways: my own address, with a link to the guide', async () => {
    const { api } = await open();
    await click(buttonStarting('Other ways'));
    expect(buttonByText(host, 'Create team')!.disabled).toBe(true);
    await typeInto(field('Team name'), 'Acme');
    await typeInto(field('Your name'), 'Maya');
    await typeInto(field('Relay address'), 'https://relay.example.com');
    const guide = [...host.querySelectorAll('a')].find((a) => a.textContent === 'How to host your own') as HTMLAnchorElement;
    expect(guide.getAttribute('href')).toBe(RELAY_HELP_URL);
    expect(guide.target).toBe('_blank');
    expect(guide.rel).toContain('noreferrer');
    await click(buttonByText(host, 'Create team'));
    await settle();
    expect(api.calls.filter((c) => c.startsWith('create'))).toEqual(['create({"teamName":"Acme","name":"Maya","relay":"https://relay.example.com","folder":""})']);
  });

  it('other ways: a shared folder replaces the relay address', async () => {
    const { api } = await open();
    await click(buttonStarting('Other ways'));
    await click(buttonByText(host, 'Use a shared folder'));
    expect(field('Relay address')).toBeUndefined();
    await typeInto(field('Team name'), 'Acme');
    await typeInto(field('Shared folder'), 'D:\\team\\wire');
    await click(buttonByText(host, 'Create team'));
    await settle();
    expect(api.calls.find((c) => c.startsWith('create'))).toBe('create({"teamName":"Acme","name":"Pat","relay":"","folder":"D:\\\\team\\\\wire"})');
  });
});

describe('join a team', () => {
  const open = async (props: { displayName?: string } = {}) => {
    const m = await mount(teamConfig(NOT_ON_TEAM), props);
    await click(buttonStarting('Join a team'));
    return m;
  };

  it('Join stays off until an invite is pasted; a link with a message around it is found right away', async () => {
    const { api } = await open();
    expect(buttonByText(host, 'Join')!.disabled).toBe(true);
    expect(field('Your name').value).toBe('Pat');
    await typeInto(input('Invite link'), `Hey! Join our team here: ${INVITE}. The code is in the next message.`);
    expect(hasText(host, 'Invite found for “Acme”.')).toBe(true);
    // The link is there, the code is not yet.
    expect(buttonByText(host, 'Join')!.disabled).toBe(true);
    expect(hasText(host, 'Type the 8-letter code')).toBe(true);
    await typeInto(field('Code'), 'abcdefgh');
    expect(field('Code').value).toBe('ABCD-EFGH');
    expect(buttonByText(host, 'Join')!.disabled).toBe(false);
    await click(buttonByText(host, 'Join'));
    await settle();
    expect(api.calls.find((c) => c.startsWith('join'))).toBe(`join({"link":"${INVITE}","code":"ABCD-EFGH","name":"Pat","github":null})`);
  });

  it('a code pasted together with the link fills the code in', async () => {
    await open({ displayName: 'Leo' });
    await typeInto(input('Invite link'), `${INVITE}\nCode: kq7m-4xpd`);
    expect(field('Code').value).toBe('KQ7M-4XPD');
    expect(field('Your name').value).toBe('Leo');
    expect(buttonByText(host, 'Join')!.disabled).toBe(false);
  });

  it('after Join: a clear "Waiting for the owner" state, and Cancel request leaves', async () => {
    const { api } = await open();
    await typeInto(input('Invite link'), `${INVITE} code KQ7M-4XPD`);
    await click(buttonByText(host, 'Join'));
    await settle();
    expect(hasText(host, 'Waiting for the owner of “Acme” to let you in')).toBe(true);
    expect(host.querySelectorAll('input, textarea')).toHaveLength(0);
    await click(buttonByText(host, 'Cancel request'));
    await settle();
    expect(api.calls).toContain('leave()');
    expect(hasText(host, 'Start a team')).toBe(true);
  });

  it('text that is not an invite is said plainly', async () => {
    await open();
    await typeInto(input('Invite link'), 'https://example.com/nope');
    expect(host.querySelector('[role="alert"]')!.textContent).toContain("doesn't look like an invite");
    expect(buttonByText(host, 'Join')!.disabled).toBe(true);
  });
});

describe('already waiting to be let in', () => {
  it('shows the waiting state on open', async () => {
    await mount(teamConfig({ ...NOT_ON_TEAM, joining: 'Acme' }));
    expect(hasText(host, 'Waiting for the owner of “Acme” to let you in')).toBe(true);
    expect(hasText(host, 'Start a team')).toBe(false);
  });
});

describe('a settings file that could not be read', () => {
  it('is said plainly', async () => {
    await mount(teamConfig({ ...NOT_ON_TEAM, readError: 'expected value at line 1' }));
    const alert = host.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain("couldn't be read");
    expect(alert.textContent).toContain('team.json.unreadable');
    expect(alert.textContent).toContain('expected value at line 1');
  });
});

describe('on a team as the owner', () => {
  it('shows the team, the status, and the people in words; never an id', async () => {
    await mount(teamConfig());
    expect(hasText(host, 'Acme')).toBe(true);
    expect(hasText(host, "You're the owner")).toBe(true);
    expect(host.querySelector('.tp-status')!.textContent).toContain('Connected');
    expect(hasText(host, 'Leo (you)')).toBe(true);
    expect(hasText(host, 'Owner')).toBe(true);
    expect(hasText(host, 'Can answer')).toBe(true);
    expect(hasText(host, 'Watching')).toBe(true);
    expect(hasText(host, 'GitHub: maya-dev')).toBe(true);
    expect(hasText(host, 'GitHub: samc (claimed)')).toBe(true);
    for (const id of ['team-7f3a91c2', 'm-maya', 'm-sam', 'm-leo', 'j-priya']) expect(host.textContent).not.toContain(id);
  });

  it('waiting people have Let in and Decline right there', async () => {
    const { api } = await mount(teamConfig());
    expect(hasText(host, 'Priya wants to join')).toBe(true);
    expect(hasText(host, 'GitHub: priya-dev (claimed)')).toBe(true);
    expect(hasText(host, "Priya's MacBook")).toBe(true);
    await click(buttonByText(host, 'Let in'));
    await settle();
    expect(api.calls).toContain('approveJoin("j-priya")');
    expect(hasText(host, 'Priya wants to join')).toBe(false);
  });

  it('Decline turns the request down', async () => {
    const { api } = await mount(teamConfig());
    await click(buttonByText(host, 'Decline'));
    await settle();
    expect(api.calls).toContain('declineJoin("j-priya")');
  });

  it('flags a request when more than one person used the same code', async () => {
    const base = teamConfig();
    const warning = "Someone else also used this invite's code. Only let in the person you invited.";
    await mount({ ...base, joins: base.joins.map((j) => ({ ...j, warning })) });
    expect(host.querySelector('.st-team-warning[role="alert"]')?.textContent).toBe(warning);
  });

  it('a claimed GitHub login can be confirmed by the owner; a confirmed one cannot', async () => {
    const { api } = await mount(teamConfig());
    const confirms = [...host.querySelectorAll('button')].filter((b) => b.textContent === 'Confirm GitHub');
    expect(confirms).toHaveLength(1);
    await click(confirms[0]);
    await settle();
    expect(api.calls).toContain('confirmGithub("m-sam")');
  });

  it('Remove asks first, says what it does, and removes only after the confirm', async () => {
    const { api } = await mount(teamConfig());
    const removes = [...host.querySelectorAll('button')].filter((b) => b.textContent === 'Remove');
    expect(removes).toHaveLength(2); // Maya and Sam, never me
    await click(removes[0]);
    expect(sheet()!.textContent).toContain('Remove Maya?');
    expect(sheet()!.textContent).toContain("They keep what they already received. The team key changes, so they can't read anything new.");
    expect(api.calls.some((c) => c.startsWith('removeMember'))).toBe(false);
    await click(sheetButton('Remove'));
    await settle();
    expect(api.calls).toContain('removeMember("m-maya")');
    expect(sheet()).toBeNull();
  });

  it('Cancel on the Remove sheet removes nobody', async () => {
    const { api } = await mount(teamConfig());
    await click([...host.querySelectorAll('button')].find((b) => b.textContent === 'Remove'));
    await click(sheetButton('Cancel'));
    expect(api.calls.some((c) => c.startsWith('removeMember'))).toBe(false);
  });

  it('a team with others on it makes an invite only when asked; it shows the link, the code, a QR and how to send it', async () => {
    const { api } = await mount(teamConfig());
    expect(api.calls).not.toContain('invite()');
    await click(buttonByText(host, 'Make an invite'));
    await settle(5);
    expect(api.calls).toContain('invite()');
    expect(host.querySelector('.st-invite-code')!.textContent).toBe('KQ7M-4XPD');
    expect((host.querySelector('input[aria-label="Invite link"]') as HTMLInputElement).value).toBe('pm://team/join?t=Acme&k=abc123');
    expect(hasText(host, 'Send this to your teammate. Send the link and the code in two separate messages.')).toBe(true);
    expect(hasText(host, 'Expires at')).toBe(true);
    expect(host.querySelector('canvas')).not.toBeNull();
    expect(host.textContent).not.toContain('team-7f3a91c2');
  });

  it('a team of one (just started) shows the invite straight away', async () => {
    const { api } = await mount(JUST_ME());
    expect(api.calls).toContain('invite()');
    expect(host.querySelector('.st-invite-code')!.textContent).toBe('KQ7M-4XPD');
  });

  it('Copy puts the link on the clipboard, Copy code the code', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await mount(JUST_ME());
    await click(buttonByText(host, 'Copy'));
    expect(writeText).toHaveBeenCalledWith('pm://team/join?t=Acme&k=abc123');
    await click(buttonByText(host, 'Copy code'));
    expect(writeText).toHaveBeenCalledWith('KQ7M-4XPD');
  });

  it('Options are folded; Use Team and the projects save together', async () => {
    const { api, onSaved } = await mount(teamConfig({ enabled: false }));
    expect(host.querySelector('[role="switch"][aria-label="Use Team"]')).toBeNull();
    await click(buttonStarting('Options'));
    await typeInto(field('Projects'), 'C:\\work\\billing\n\nC:\\work\\web');
    await click(host.querySelector('[role="switch"][aria-label="Use Team"]'));
    await settle();
    expect(api.calls.find((c) => c.startsWith('configSet'))).toBe('configSet({"enabled":true,"projects":["C:\\\\work\\\\billing","C:\\\\work\\\\web"]})');
    expect(onSaved).toHaveBeenCalled();
  });

  it('Leave team is last, asks first, then leaves', async () => {
    const { api } = await mount(teamConfig());
    const all = buttons();
    expect(all[all.length - 1]).toBe('Leave team');
    await click(buttonByText(host, 'Leave team'));
    expect(sheet()!.textContent).toContain('Leave this team?');
    expect(api.calls).not.toContain('leave()');
    await click(sheetButton('Leave'));
    await settle();
    expect(api.calls).toContain('leave()');
    expect(hasText(host, 'Start a team')).toBe(true);
  });
});

describe('the status line', () => {
  it('says Connected for a live relay and for a shared folder', () => {
    expect(connectionOf(teamConfig({ link: 'live' }))).toMatchObject({ state: 'ok', title: 'Connected', action: null });
    expect(connectionOf(teamConfig({ transport: 'folder', link: null }))).toMatchObject({ state: 'ok', title: 'Connected' });
  });

  it('says Connecting while the relay has not answered yet', () => {
    expect(connectionOf(teamConfig({ link: null }))).toMatchObject({ state: 'wait', title: 'Connecting…' });
  });

  it("can't reach the relay: says what is wrong and offers Try again, which saves again", async () => {
    expect(connectionOf(teamConfig({ link: 'offline', relay: 'https://relay.acme.dev' })).detail).toContain('relay.acme.dev');
    const { api } = await mount(teamConfig({ link: 'offline' }));
    expect(host.querySelector('.tp-status')!.textContent).toContain("Can't reach the relay");
    await click(buttonByText(host, 'Try again'));
    await settle();
    expect(api.calls.find((c) => c.startsWith('configSet'))).toBe('configSet({"enabled":true,"projects":[]})');
  });

  it('connecting: shows Connecting, then Connected once the link comes up, without a changed event', async () => {
    vi.useFakeTimers();
    try {
      const api = fakeApi(teamConfig({ link: 'connecting' }));
      let reads = 0;
      api.configGet = async () => {
        reads += 1;
        return teamConfig({ link: reads >= 3 ? 'live' : 'connecting' });
      };
      await act(async () => root.render(<TeamPage api={api} />));
      await settle(5);
      expect(host.querySelector('.tp-status')!.textContent).toContain('Connecting');
      expect(host.querySelector('.tp-status')!.textContent).not.toContain("Can't reach");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(host.querySelector('.tp-status')!.textContent).toContain('Connecting');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      await settle(5);
      expect(host.querySelector('.tp-status')!.textContent).toContain('Connected');
      // Up: it stops asking.
      const before = reads;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(reads).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('denied: says the relay turned this computer away and to ask the owner', async () => {
    expect(connectionOf(teamConfig({ link: 'denied' }))).toMatchObject({ state: 'bad', title: 'The relay turned this computer away', detail: 'Ask the owner to let you in again.', action: null });
  });

  it("the app's own error text is the reason when there is one", () => {
    expect(connectionOf(teamConfig({ link: 'offline', error: 'The relay answered 401.' })).detail).toBe('The relay answered 401.');
  });

  it('paused: Turn on', async () => {
    const { api } = await mount(teamConfig({ enabled: false }));
    expect(host.querySelector('.tp-status')!.textContent).toContain('Paused');
    await click(buttonByText(host, 'Turn on'));
    await settle();
    expect(api.calls.find((c) => c.startsWith('configSet'))).toContain('"enabled":true');
  });
});

describe('on a team as a member', () => {
  it('has no invite, Remove or request buttons', async () => {
    await mount(
      teamConfig({
        admin: false,
        joins: [],
        members: [
          { id: 'm-leo', name: 'Leo', roles: ['admin'], admin: true, me: false, github: null, githubConfirmed: false, devices: 1 },
          { id: 'm-me', name: 'Maya', roles: ['approve'], admin: false, me: true, github: null, githubConfirmed: false, devices: 1 },
        ],
      }),
    );
    expect(hasText(host, '2 people')).toBe(true);
    expect(hasText(host, 'Invite someone')).toBe(false);
    expect(buttonByText(host, 'Remove')).toBeUndefined();
    expect(buttonByText(host, 'Leave team')).toBeDefined();
  });
});

describe('pinging the people of a relay team', () => {
  it('a ping that answers with nothing says it plainly, never a raw JS error', async () => {
    const api = fakeApi(teamConfig());
    api.ping = async () => null as unknown as Awaited<ReturnType<NonNullable<TeamApi['ping']>>>;
    await act(async () => root.render(<TeamPage api={api} />));
    await settle(5);
    expect(hasText(host, "Couldn't check who is online. Try Ping again.")).toBe(true);
    expect(host.textContent).not.toContain('reading');
    expect(host.textContent).not.toContain('Cannot read properties');
    expect(hasText(host, 'Leo (you)')).toBe(true);
  });

  it('a ping that throws shows the same plain sentence, and Ping again clears it when it works', async () => {
    const api = fakeApi(teamConfig());
    let fail = true;
    api.ping = async () => {
      if (fail) throw new TypeError("Cannot read properties of null (reading 'map')");
      return [];
    };
    await act(async () => root.render(<TeamPage api={api} />));
    await settle(5);
    expect(hasText(host, "Couldn't check who is online. Try Ping again.")).toBe(true);
    expect(host.textContent).not.toContain('Cannot read properties');
    fail = false;
    await click(buttonByText(host, 'Ping'));
    await settle();
    expect(hasText(host, "Couldn't check who is online")).toBe(false);
  });
});
