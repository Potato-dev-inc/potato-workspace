// @vitest-environment jsdom
// Settings > Lend: profiles and their editor (a lend sign-in or a pasted API key), active lends with usage and problems.
// There are no .pm parts in this mode.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeLendApi, GRANT_IN, GRANT_IN_PROBLEM, GRANT_OUT, KEY_PROFILE, LEND_MEMBERS, MY_PROFILE } from '../../../dev/lend-fixtures';
import { teamConfig } from '../../../dev/team-fixtures';
import type { AccountsApi } from '../../../lib/accounts';
import type { TeamApi } from '../../../lib/team';
import { buttonByText, click, pickOption, settle, type as typeInto } from '../test-utils';
import { resetDraftForTests } from '../../../lib/lendDraft';
import { LendPage } from './LendPage';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  // The draft of a new profile lives outside React (and in sessionStorage): every test starts without one.
  window.sessionStorage.clear();
  resetDraftForTests();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const openLoginPane = vi.fn(async () => 'pane-login');
// The terminal needs the real pane stream; the sign-in tests are about the flow, not about xterm.
vi.mock('../../lend/SignInTerminal', () => ({ SignInTerminal: ({ paneId }: { paneId: string }) => <div data-testid="fake-terminal">{paneId}</div> }));
const accountsApi = {
  list: async () => ({
    agents: [],
    accounts: [
      { id: 'acct-lend', agent_id: 'claude', label: 'Lend login', home: 'C:\\lend', lend_only: true },
      // My own login: never a choice for lending.
      { id: 'acct-own', agent_id: 'claude', label: 'Work', home: 'C:\\work' },
    ],
  }),
  openLoginPane,
} as unknown as AccountsApi;
const team = { configGet: async () => teamConfig({ members: LEND_MEMBERS }) } as unknown as TeamApi;

async function mount(seed = {}) {
  const api = createFakeLendApi(seed);
  // The lend sign-in the seeded profiles use is signed in.
  api.backend.setSignIn('acct-lend', { state: 'signed_in', identity: 'ren@example.com' });
  const onSaved = vi.fn();
  await act(async () => root.render(<LendPage api={api} team={team} accountsApi={accountsApi} onSaved={onSaved} />));
  await settle(5);
  return { api, onSaved };
}
const section = (label: string) => host.querySelector<HTMLElement>(`section[aria-label="${label}"]`)!;
const input = (within: ParentNode, label: string) => within.querySelector<HTMLInputElement & HTMLSelectElement>(`[aria-label="${label}"]`)!;
const checkboxIn = (within: ParentNode, text: string) => [...within.querySelectorAll<HTMLInputElement>('input')].find((i) => i.parentElement?.textContent?.includes(text))!;
const sheet = () => host.querySelector<HTMLElement>('.lend-sheet')!;
const card = (text: string) => [...sheet().querySelectorAll<HTMLInputElement>('.lend-card input')].find((i) => i.parentElement?.textContent?.includes(text))!;
const stepText = () => host.querySelector('[data-testid="lend-steps"]')?.textContent ?? '';
const next = () => click(buttonByText(sheet(), 'Next'));
const wait = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
/** Step 1 filled in: the name and Claude. */
async function stepOne(name = 'Work account', agent = 'Claude') {
  await typeInto(input(sheet(), 'Name'), name);
  await click(card(agent));
}
/** Walks to step 3 on the sign-in that is already signed in. */
async function toStepThree(name = 'Work account') {
  await click(buttonByText(host, 'New lend profile'));
  await stepOne(name);
  await next();
  await click(card('Use a sign-in I already added'));
  await pickOption(input(sheet(), 'Lend sign-in'), 'acct-lend');
  await settle(3);
  await next();
}

describe('Lend profiles', () => {
  it('lists the profiles with who, how long, whether it asks first and its limits', async () => {
    await mount({ profiles: [MY_PROFILE, KEY_PROFILE] });
    const text = section('Lend profiles').textContent!;
    expect(text).toContain('My other PCs');
    expect(text).toContain('up to 24 hours');
    expect(text).toContain('Up to 200 requests and 500,000 tokens');
  });

  it('draws nothing while the switch is off', async () => {
    await mount({ enabled: false });
    expect(host.textContent).toBe('');
  });

  it('hides the .pm parts: no Save as .pm file, no Open .pm file', async () => {
    const { api } = await mount();
    expect(section('Save as .pm file')).toBeNull();
    expect(section('Open .pm file')).toBeNull();
    expect(host.textContent).not.toContain('.pm');
    expect(api.calls.some((c) => /Pm\(/.test(c))).toBe(false);
  });

  it('New lend profile opens the sheet on step 1; Next is blocked without a name and an agent, and says why next to the field', async () => {
    await mount({ profiles: [] });
    await click(buttonByText(host, 'New lend profile'));
    expect(stepText()).toContain('Step 1 of 4');
    expect(sheet().getAttribute('data-size')).toBe('wide');
    await next();
    // Still on step 1, and each field says what is missing right beside it.
    expect(stepText()).toContain('Step 1 of 4');
    expect(sheet().querySelector('label.lend-field')!.textContent).toContain('Give it a name.');
    expect(sheet().querySelector('fieldset.lend-cards')!.textContent).toContain('Pick an agent.');
    await typeInto(input(sheet(), 'Name'), 'Work account');
    expect(sheet().textContent).toContain("They will see: Claude · Leo's Work account (borrowed)");
    await click(card('Claude'));
    await next();
    expect(stepText()).toContain('Step 2 of 4');
  });

  it('the agents are one choice each, with small tags: Early test, and API key only for Codex and Gemini', async () => {
    await mount({ profiles: [] });
    await click(buttonByText(host, 'New lend profile'));
    const rows = [...sheet().querySelectorAll('fieldset.lend-cards label')].map((l) => l.textContent);
    expect(rows).toEqual(['ClaudeEarly test', 'CodexAPI key onlyEarly test', 'Gemini CLIAPI key onlyEarly test']);
    expect(sheet().textContent).not.toContain('Main sign-in');
    expect(sheet().textContent).not.toContain('Coming later');
    expect([...sheet().querySelectorAll<HTMLInputElement>('fieldset.lend-cards input')].every((i) => i.type === 'radio')).toBe(true);
  });

  it('Sign in happens INSIDE the sheet: it starts the hidden sign-in, never opens a pane, and the sheet and the name stay', async () => {
    const { api } = await mount({ profiles: [] });
    await click(buttonByText(host, 'New lend profile'));
    await stepOne();
    await next();
    await click(buttonByText(sheet(), 'Sign in'));
    await settle(3);
    expect(api.calls).toContain('accountAdd("claude","Lend Claude")');
    expect(api.calls).toContain('signInStart("acct-1")');
    // Never the Accounts-page helper, never a normal pane: Settings stays and the draft is still there.
    expect(openLoginPane).not.toHaveBeenCalled();
    expect(sheet()).not.toBeNull();
    expect(stepText()).toContain('Step 2 of 4');
    expect(sheet().querySelector('[data-testid="fake-terminal"]')!.textContent).toBe('signin-pane-acct-1');
    expect(sheet().textContent).toContain('Waiting for you to sign in');
    // Back to step 1: the name is still there.
    await click(buttonByText(sheet(), 'Back'));
    expect(input(sheet(), 'Name').value).toBe('Work account');
  });

  it('when the sign-in turns signed in, the step says who and Next goes on; before that Next is refused', async () => {
    const { api } = await mount({ profiles: [] });
    await click(buttonByText(host, 'New lend profile'));
    await stepOne();
    await next();
    await click(buttonByText(sheet(), 'Sign in'));
    await settle(3);
    await next();
    expect(stepText()).toContain('Step 2 of 4');
    expect(sheet().textContent).toContain('Sign in first.');
    api.backend.setSignIn('acct-1', { state: 'signed_in', identity: 'ren@example.com' });
    await wait(1700);
    expect(sheet().textContent).toContain('Signed in as ren@example.com');
    await next();
    expect(stepText()).toContain('Step 3 of 4');
    // After the fold the hidden pane is stopped, the sign-in stays.
    await wait(1200);
    expect(api.calls).toContain('signInStop("acct-1",false)');
  });

  it('a failed sign-in says so and offers Try again and a key; Cancel sign-in stops it, forgets the empty account and goes back to the choices', async () => {
    const { api } = await mount({ profiles: [] });
    await click(buttonByText(host, 'New lend profile'));
    await stepOne();
    await next();
    await click(buttonByText(sheet(), 'Sign in'));
    await settle(3);
    api.backend.setSignIn('acct-1', { pane_alive: false });
    await wait(1700);
    expect(sheet().textContent).toContain('That did not work. Try again.');
    expect(buttonByText(sheet(), 'Paste an API key instead')).toBeDefined();
    await click(buttonByText(sheet(), 'Try again'));
    await settle(3);
    expect(api.backend.added).toHaveLength(1);
    await click(buttonByText(sheet(), 'Cancel sign-in'));
    await settle(3);
    expect(api.calls).toContain('signInStop("acct-1",true)');
    expect(api.backend.added).toHaveLength(0);
    expect(sheet().textContent).toContain('No sign-in yet.');
    expect(sheet().querySelector('[data-testid="fake-terminal"]')).toBeNull();
    expect(card('Sign in to an account').checked).toBe(true);
    await click(buttonByText(sheet(), 'Back'));
    expect(input(sheet(), 'Name').value).toBe('Work account');
  });

  it('closing the sheet on step 2 leaves a "Finish setting up" row; Continue reopens on step 2 with the same values and the same account', async () => {
    const { api } = await mount({ profiles: [] });
    await click(buttonByText(host, 'New lend profile'));
    await stepOne();
    await next();
    await click(buttonByText(sheet(), 'Sign in'));
    await settle(3);
    await click(host.querySelector('button[aria-label="Close"]'));
    await settle(2);
    expect(host.querySelector('.lend-sheet')).toBeNull();
    // The hidden pane went with the sheet; the account and the draft stay.
    expect(api.calls).toContain('signInStop("acct-1",false)');
    const row = host.querySelector('[data-testid="lend-draft-row"]')!;
    expect(row.textContent).toContain('Finish setting up "Work account" · Step 2 of 4');
    expect(buttonByText(host, 'New lend profile')).toBeUndefined();
    const adds = api.calls.filter((c) => c.startsWith('accountAdd(')).length;
    await click(buttonByText(row as HTMLElement, 'Continue'));
    await settle(3);
    expect(stepText()).toContain('Step 2 of 4');
    expect(api.calls.filter((c) => c.startsWith('accountAdd(')).length).toBe(adds);
    await click(buttonByText(sheet(), 'Back'));
    expect(input(sheet(), 'Name').value).toBe('Work account');
    expect(card('Claude').checked).toBe(true);
    await next();
    // Sign in again for the same draft: the same account comes back, no second "Lend Claude".
    await click(buttonByText(sheet(), 'Sign in'));
    await settle(3);
    expect(api.backend.added.map((a) => a.id)).toEqual(['acct-1']);
  });

  it('Discard asks whether to remove the sign-in the draft added, and removes it only when told to', async () => {
    const remove = vi.fn(async () => true);
    const { api } = await mount({ profiles: [] });
    (accountsApi as unknown as { remove: typeof remove }).remove = remove;
    await click(buttonByText(host, 'New lend profile'));
    await stepOne();
    await next();
    await click(buttonByText(sheet(), 'Sign in'));
    await settle(3);
    await click(host.querySelector('button[aria-label="Close"]'));
    await settle(2);
    const row = () => host.querySelector<HTMLElement>('[data-testid="lend-draft-row"]')!;
    await click(buttonByText(row(), 'Discard'));
    expect(row().textContent).toContain('Also remove the sign-in you added for it?');
    await click(buttonByText(row(), 'Remove it'));
    await settle(3);
    expect(remove).toHaveBeenCalledWith('acct-1', true);
    expect(host.querySelector('[data-testid="lend-draft-row"]')).toBeNull();
    expect(buttonByText(host, 'New lend profile')).toBeDefined();
    expect(api.calls.filter((c) => c.startsWith('profileSave(')).length).toBe(0);
  });

  it('the draft survives a reload of the page (sessionStorage), but never the API key', async () => {
    await mount({ profiles: [] });
    await click(buttonByText(host, 'New lend profile'));
    await stepOne('Key loans', 'Codex');
    await next();
    await typeInto(input(sheet(), 'API key'), 'sk-FAKE-OPENAI');
    await click(host.querySelector('button[aria-label="Close"]'));
    await settle(2);
    const stored = window.sessionStorage.getItem('pm.lend.draft.v1')!;
    expect(stored).toContain('Key loans');
    expect(stored).not.toContain('sk-FAKE');
    // A new page load: the memory is gone, the storage is read.
    await act(async () => root.unmount());
    resetDraftForTests();
    root = createRoot(host);
    await mount({ profiles: [] });
    const row = host.querySelector('[data-testid="lend-draft-row"]')!;
    expect(row.textContent).toContain('Finish setting up "Key loans" · Step 2 of 4');
    await click(buttonByText(row as HTMLElement, 'Continue'));
    expect(input(sheet(), 'API key').value).toBe('');
  });

  it('Save calls profileSave once with one agent id, then closes the sheet and shows the row', async () => {
    const { api, onSaved } = await mount({ profiles: [] });
    await toStepThree('Short loans');
    expect(stepText()).toContain('Step 3 of 4');
    await next();
    expect(stepText()).toContain('Step 4 of 4');
    expect(sheet().textContent).toContain('Ready to lend');
    expect(sheet().textContent).toContain('Short loans');
    expect(sheet().textContent).toContain('Claude · Signed in as ren@example.com');
    expect(sheet().textContent).toContain('My other PCs · 8 hours each time · asks me first');
    expect(sheet().textContent).toContain('This PC stays awake while lending');
    expect(sheet().textContent).toContain('Nothing is lent yet.');
    await click(buttonByText(sheet(), 'Save profile'));
    await settle(4);
    const saves = api.calls.filter((c) => c.startsWith('profileSave('));
    expect(saves).toHaveLength(1);
    expect(saves[0]).toContain('"name":"Short loans"');
    expect(saves[0]).toContain('"agent_ids":["claude"]');
    expect(saves[0]).toContain('"account":{"kind":"account","id":"acct-lend"}');
    expect(saves[0]).toContain('"default_secs":28800');
    expect(api.calls.some((c) => c.startsWith('keySet('))).toBe(false);
    expect(onSaved).toHaveBeenCalled();
    expect(host.querySelector('.lend-sheet')).toBeNull();
    expect(section('Lend profiles').textContent).toContain('Short loans');
    expect(host.querySelector('[data-testid="lend-saved"]')!.textContent).toBe('"Short loans" is ready to lend.');
    expect(host.querySelector('[data-testid="lend-draft-row"]')).toBeNull();
    expect(window.sessionStorage.getItem('pm.lend.draft.v1')).toBeNull();
  });

  it('review lines have Change: it goes to that step and back, and the sign-in line is live', async () => {
    const { api } = await mount({ profiles: [] });
    await toStepThree();
    await next();
    await click(sheet().querySelector('button[aria-label^="Change: Work account"]'));
    expect(stepText()).toContain('Step 1 of 4');
    await typeInto(input(sheet(), 'Name'), 'Renamed');
    await next();
    await next();
    await next();
    expect(sheet().querySelector('[data-testid="lend-review-name"]')!.textContent).toBe('Renamed');
    // The sign-in went out while the sheet was open: the line says so and Save is held back.
    api.backend.setSignIn('acct-lend', { state: 'signed_out', identity: null });
    await click(sheet().querySelector('button[aria-label^="Change: Claude"]'));
    await settle(3);
    expect(sheet().textContent).toContain('Signed out. Sign in again.');
  });

  it('Codex and Gemini can only be lent with a key: the sign-in choices are off and say why in plain words', async () => {
    const { api } = await mount({ profiles: [] });
    await click(buttonByText(host, 'New lend profile'));
    await stepOne('Codex loans', 'Codex');
    await next();
    expect(sheet().querySelector('[data-testid="lend-signin-not-yet"]')!.textContent).toBe('Codex signed in with ChatGPT is not supported yet. Only an OpenAI API key can be lent.');
    expect(sheet().textContent).not.toContain('Sign in to an account');
    expect(buttonByText(sheet(), 'Sign in')).toBeUndefined();
    await next();
    expect(sheet().textContent).toContain('Paste an API key.');
    await typeInto(input(sheet(), 'API key'), 'sk-FAKE-OPENAI');
    await next();
    await next();
    expect(sheet().textContent).toContain('API key saved on this PC');
    await click(buttonByText(sheet(), 'Save profile'));
    await settle(4);
    const save = api.calls.find((c) => c.startsWith('profileSave('))!;
    expect(save).toContain('"agent_ids":["codex"]');
    expect(save).toContain('"account":{"kind":"main"}');
    expect(api.calls.join(' ')).not.toContain('sk-FAKE-OPENAI');
    expect(api.calls).toContain('keySet("prof-1","(key)")');
  });

  it('picking another agent starts the sign-in step fresh (a sign-in belongs to one agent)', async () => {
    await mount({ profiles: [] });
    await click(buttonByText(host, 'New lend profile'));
    await stepOne();
    await click(card('Gemini'));
    await next();
    expect(sheet().querySelector('[data-testid="lend-signin-not-yet"]')!.textContent).toContain('Gemini signed in with Google is not supported yet.');
    await click(buttonByText(sheet(), 'Back'));
    await click(card('Claude'));
    await next();
    expect(sheet().querySelector('[data-testid="lend-signin-not-yet"]')).toBeNull();
    expect(card('Sign in to an account').checked).toBe(true);
  });

  it('a teammates profile needs the tick, shows the new risk words (no "send my login"), and caps it at 24 hours', async () => {
    await mount();
    await toStepThree('Friends');
    await click(checkboxIn(sheet(), 'Teammates'));
    const box = sheet().querySelector<HTMLElement>('[data-lend-warning]')!;
    expect(box.textContent).toContain('Use at your own risk');
    expect(box.textContent).toContain('Your sign-in stays on this PC. What they send goes through this PC, so this PC can see it.');
    expect(box.textContent).toContain('You can take it back at any time.');
    expect(box.textContent).not.toMatch(/Send my login|copy of your sign-in|Through my PC/i);
    expect(sheet().textContent).toContain('Maya');
    await next();
    expect(stepText()).toContain('Step 3 of 4');
    expect(sheet().textContent).toContain('Tick "I understand" first.');
    await click(checkboxIn(sheet(), 'I understand'));
    const customs = [...sheet().querySelectorAll('button')].filter((b) => b.textContent === 'Custom');
    await click(customs[0]);
    await typeInto(sheet().querySelectorAll<HTMLInputElement>('input[aria-label="Hours"]')[0], '25');
    expect(sheet().textContent).toContain('24 hours at most');
    await next();
    expect(stepText()).toContain('Step 3 of 4');
    await typeInto(sheet().querySelectorAll<HTMLInputElement>('input[aria-label="Hours"]')[0], '2');
    await next();
    expect(stepText()).toContain('Step 4 of 4');
    // None ticked: anyone on the team may ask.
    expect(sheet().textContent).toContain('Teammates · 2 hours each time · asks me first');
  });

  it('"Keep this PC awake" sits under More options, on by default, and is saved when turned off', async () => {
    const { api } = await mount();
    await toStepThree();
    expect(sheet().textContent).not.toContain('Keep this PC awake while lending');
    await click(buttonByText(sheet(), 'More options'));
    const row = checkboxIn(sheet(), 'Keep this PC awake while lending');
    expect(row.checked).toBe(true);
    await click(row);
    await next();
    expect(sheet().textContent).toContain('This PC may sleep while lending');
    await click(buttonByText(sheet(), 'Save profile'));
    await settle(3);
    expect(api.calls.find((c) => c.startsWith('profileSave('))).toContain('"keep_awake":false');
  });

  it('Edit opens the same sheet on the review step; Delete asks first when the profile is lent right now', async () => {
    const lent = { ...GRANT_OUT, profile_name: MY_PROFILE.name, profile_id: MY_PROFILE.id };
    const { api } = await mount({ grants: [lent] });
    await click(buttonByText(section('Lend profiles'), 'Edit'));
    expect(stepText()).toContain('Step 4 of 4');
    expect(sheet().textContent).toContain('Edit lend profile');
    await click(sheet().querySelector('button[aria-label^="Change: My other PCs"]'));
    await settle(2);
    expect(stepText()).toContain('Step 1 of 4');
    await typeInto(input(sheet(), 'Name'), 'Renamed');
    await next();
    await next();
    await next();
    await click(buttonByText(sheet(), 'Save profile'));
    await settle(3);
    expect(api.calls.find((c) => c.startsWith('profileSave('))).toContain('"id":"prof-mine"');
    await click(host.querySelector('button[aria-label="Delete Renamed"]'));
    expect(section('Lend profiles').textContent).toContain('"Renamed" is lent to Maya right now. Deleting it takes it back.');
    expect(api.calls.some((c) => c.startsWith('profileDelete('))).toBe(false);
    await click(buttonByText(section('Lend profiles'), 'Delete'));
    await settle(3);
    expect(api.calls).toContain('profileDelete("prof-mine")');
  });

  it('a profile that is not lent is deleted at once; closing an edit leaves no draft row', async () => {
    const { api } = await mount();
    await click(buttonByText(section('Lend profiles'), 'Edit'));
    await click(host.querySelector('button[aria-label="Close"]'));
    await settle(2);
    expect(host.querySelector('[data-testid="lend-draft-row"]')).toBeNull();
    await click(host.querySelector(`button[aria-label="Delete ${MY_PROFILE.name}"]`));
    await settle(3);
    expect(api.calls).toContain('profileDelete("prof-mine")');
  });

  it('a profile that keeps a key says so, and can drop it by switching to a sign-in', async () => {
    const { api } = await mount({ profiles: [KEY_PROFILE] });
    await click(buttonByText(section('Lend profiles'), 'Edit'));
    expect(sheet().querySelector('[data-testid="lend-review-signin"]')!.textContent).toContain('API key saved on this PC');
    await click(sheet().querySelector('button[aria-label^="Change: Claude"]'));
    expect(input(sheet(), 'API key').placeholder).toContain('A key is saved');
    await click(card('Use a sign-in I already added'));
    await pickOption(input(sheet(), 'Lend sign-in'), 'acct-lend');
    await settle(3);
    await next();
    await next();
    await click(buttonByText(sheet(), 'Save profile'));
    await settle(3);
    expect(api.calls).toContain('keySet("prof-key","")');
  });
});

describe('Active lends', () => {
  it('shows both ways with Take back and Give back, and what the lender used', async () => {
    const { api } = await mount({ grants: [GRANT_OUT, GRANT_IN] });
    const box = section('Active lends');
    expect(box.textContent).toMatch(/Lending Claude to Maya/);
    expect(box.textContent).toMatch(/Borrowing Claude from Sam/);
    expect(box.textContent).toContain('Used so far: 14 requests · 62.1k tokens');
    // Taking back asks first.
    await click(buttonByText(box, 'Take back'));
    expect(box.textContent).toContain('Take back Claude from Maya? Their agent stops now.');
    expect(api.calls.some((c) => c.startsWith('revoke('))).toBe(false);
    await click(buttonByText(section('Active lends'), 'Take back'));
    await settle(3);
    expect(api.calls).toContain('revoke("grant-out-1")');
    expect(section('Active lends').textContent).toContain('Taken back');
  });

  it('shows the lender\'s expired sign-in as one plain sentence', async () => {
    await mount({ grants: [GRANT_IN_PROBLEM] });
    expect(section('Active lends').textContent).toContain("The lender's sign-in expired. Ask them to sign in again.");
    expect(section('Active lends').textContent).not.toContain('sign-in expired\n');
  });
});

describe('Show usage in the usage bar (per lend profile)', () => {
  it('is a checkbox on a sign-in profile, off by default, and saving it turns show_usage on; a key profile has none', async () => {
    const { api } = await mount({ profiles: [MY_PROFILE, KEY_PROFILE] });
    const rows = [...section('Lend profiles').querySelectorAll('li')];
    const mine = rows.find((r) => r.textContent?.includes('My other PCs'))!;
    const key = rows.find((r) => r.textContent?.includes('Work key'))!;
    const box = mine.querySelector<HTMLInputElement>('.lend-showusage input')!;
    expect(box.checked).toBe(false);
    expect(mine.textContent).toContain('Show usage in the usage bar');
    expect(key.querySelector('.lend-showusage')).toBeNull();
    await click(box);
    await settle(3);
    const saved = api.backend.get().profiles.find((p) => p.id === MY_PROFILE.id)!;
    expect(saved.show_usage).toBe(true);
    expect(section('Lend profiles').querySelector<HTMLInputElement>('.lend-showusage input')!.checked).toBe(true);
  });
});

describe('Past lends and borrows', () => {
  const DAY = 24 * 3600 * 1000;
  const ended = (n: number, over: Partial<typeof GRANT_IN> = {}) => ({
    ...GRANT_IN,
    id: `past-${n}`,
    state: 'ended' as const,
    end_reason: 'returned' as const,
    peer_name: `Lender ${n}`,
    ended_ms: Date.now() - n * 3600 * 1000,
    ...over,
  });

  it('keeps only active borrows in the list; past ones are collapsed (last 5, newest first), a week old ones are gone', async () => {
    const past = [1, 2, 3, 4, 5, 6, 7].map((n) => ended(n));
    const old = ended(99, { ended_ms: Date.now() - 8 * DAY, ends_ms: Date.now() - 8 * DAY });
    await mount({ grants: [GRANT_IN, ...past, old] });
    const box = section('Active lends');
    const list = box.querySelector<HTMLDetailsElement>('[data-testid="lend-past-in"]')!;
    expect(list.open).toBe(false);
    expect(list.querySelector('summary')!.textContent).toContain('Past borrows (7)');
    const names = [...list.querySelectorAll('.lend-list > li')].map((li) => li.textContent);
    expect(names).toHaveLength(5);
    expect(names[0]).toContain('Lender 1');
    expect(names[4]).toContain('Lender 5');
    expect(box.textContent).not.toContain('Lender 99');
    // The running borrow stays in the main list.
    expect(box.querySelector('.lend-list > li')!.textContent).toContain('Borrowing Claude from Sam');
  });

  it('the X removes one row and Clear removes them all, on the desktop (not only hidden)', async () => {
    const { api } = await mount({ grants: [ended(1), ended(2), ended(3, { direction: 'out' })] });
    const inList = () => section('Active lends').querySelector<HTMLElement>('[data-testid="lend-past-in"]')!;
    await click(inList().querySelector<HTMLButtonElement>('button[aria-label="Remove this row"]')!);
    await settle(3);
    expect(api.calls).toContain('dismissGrant("past-1")');
    expect(api.backend.get().grants.map((g) => g.id)).not.toContain('past-1');
    await click(buttonByText(inList(), 'Clear'));
    await settle(3);
    expect(api.calls).toContain('clearPast("in")');
    expect(section('Active lends').querySelector('[data-testid="lend-past-in"]')).toBeNull();
    // Past lends are their own list and stay until cleared.
    expect(section('Active lends').querySelector('[data-testid="lend-past-out"]')!.querySelector('summary')!.textContent).toContain('Past lends (1)');
    expect(api.backend.get().grants.map((g) => g.id)).toEqual(['past-3']);
  });
});
