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
import { LendPage, MAIN_SIGN_IN_HINT } from './LendPage';

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

const openLoginPane = vi.fn(async () => 'pane-login');
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
  const onSaved = vi.fn();
  await act(async () => root.render(<LendPage api={api} team={team} accountsApi={accountsApi} onSaved={onSaved} />));
  await settle(5);
  return { api, onSaved };
}
const section = (label: string) => host.querySelector<HTMLElement>(`section[aria-label="${label}"]`)!;
const input = (within: ParentNode, label: string) => within.querySelector<HTMLInputElement & HTMLSelectElement>(`[aria-label="${label}"]`)!;
const checkbox = (within: ParentNode, text: string) => [...within.querySelectorAll<HTMLInputElement>('input')].find((i) => i.parentElement?.textContent?.includes(text))!;
const editor = () => host.querySelector<HTMLElement>('.lend-editor')!;

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

  it('creates a profile with a lend sign-in: the main sign-in is shown but off, Codex says coming soon', async () => {
    const { api, onSaved } = await mount();
    await click(buttonByText(host, 'New profile'));
    expect(buttonByText(editor(), 'Save profile')!.disabled).toBe(true);
    await typeInto(input(editor(), 'Name'), 'Short loans');
    await click(checkbox(editor(), 'Claude'));
    // Only the lend sign-in of that agent, not my own login.
    const signIn = input(editor(), 'Lend sign-in') as HTMLSelectElement;
    expect([...signIn.options].map((o) => o.value)).toEqual(['', 'acct-lend']);
    const main = [...editor().querySelectorAll<HTMLInputElement>('input[type="radio"]')].find((i) => i.parentElement?.textContent?.includes('Main sign-in'))!;
    expect(main.disabled).toBe(true);
    expect(editor().textContent).toContain(`Main sign-in · ${MAIN_SIGN_IN_HINT}`);
    expect(editor().textContent).toContain('Codex: coming soon');
    const codex = checkbox(editor(), 'Codex: coming soon');
    expect(codex.disabled).toBe(true);
    expect(editor().textContent).toContain('Ask me before each request');
    expect([...editor().querySelectorAll('.lend-tag')].map((t) => t.textContent)).toEqual(['Lab']);
    await pickOption(signIn, 'acct-lend');
    await click(buttonByText(editor(), 'Save profile'));
    await settle(3);
    const call = api.calls.find((c) => c.startsWith('profileSave('))!;
    expect(call).toContain('"name":"Short loans"');
    expect(call).toContain('"agent_ids":["claude"]');
    expect(call).toContain('"account":{"kind":"account","id":"acct-lend"}');
    expect(call).toContain('"default_secs":28800');
    expect(api.calls.some((c) => c.startsWith('keySet('))).toBe(false);
    expect(onSaved).toHaveBeenCalled();
    expect(section('Lend profiles').textContent).toContain('Short loans');
  });

  it('"Add a lend sign-in" adds one, picks it, and says to sign in to it once in a pane', async () => {
    const { api } = await mount({ profiles: [] });
    await click(buttonByText(host, 'New profile'));
    // Needs an agent first.
    expect(buttonByText(editor(), 'Add a lend sign-in')!.disabled).toBe(true);
    await typeInto(input(editor(), 'Name'), 'Fresh');
    await click(checkbox(editor(), 'Claude'));
    await click(buttonByText(editor(), 'Add a lend sign-in'));
    await settle(3);
    expect(api.calls).toContain('accountAdd("claude","Lend Claude")');
    expect(editor().textContent).toContain('Sign in to it once in a pane');
    expect(input(editor(), 'Lend sign-in').value).toBe('acct-1');
    expect(buttonByText(editor(), 'Save profile')!.disabled).toBe(false);
    // It opens the one-time sign-in the way every account does.
    await click(buttonByText(editor(), 'Open it to sign in'));
    await settle(2);
    expect(openLoginPane).toHaveBeenCalledWith('claude', 'acct-1');
    await click(buttonByText(editor(), 'Save profile'));
    await settle(3);
    expect(api.calls.find((c) => c.startsWith('profileSave('))).toContain('"account":{"kind":"account","id":"acct-1"}');
  });

  it('"Paste an API key" saves the profile, then the key (never in the profile), with limits', async () => {
    const { api } = await mount({ profiles: [] });
    await click(buttonByText(host, 'New profile'));
    await typeInto(input(editor(), 'Name'), 'Key loans');
    await click(checkbox(editor(), 'Claude'));
    await click(checkbox(editor(), 'Paste an API key'));
    expect(buttonByText(editor(), 'Save profile')!.disabled).toBe(true);
    expect(editor().textContent).toContain('Paste an API key.');
    await typeInto(input(editor(), 'API key'), 'sk-ant-FAKE-KEY');
    await typeInto(input(editor(), 'Most requests (optional)'), '50');
    expect(buttonByText(editor(), 'Save profile')!.disabled).toBe(false);
    await click(buttonByText(editor(), 'Save profile'));
    await settle(3);
    const save = api.calls.find((c) => c.startsWith('profileSave('))!;
    expect(save).not.toContain('sk-ant');
    expect(save).toContain('"account":{"kind":"main"}');
    expect(save).toContain('"max_requests":50');
    expect(api.calls).toContain('keySet("prof-1","(key)")');
    expect(api.calls.join('\n')).not.toContain('sk-ant');
    expect(api.backend.state.profiles[0].has_key).toBe(true);
    expect(section('Lend profiles').textContent).toContain('Up to 50 requests');
  });

  it('a profile that keeps a key says so and can drop it', async () => {
    const { api } = await mount({ profiles: [KEY_PROFILE] });
    await click(buttonByText(section('Lend profiles'), 'Edit'));
    expect(input(editor(), 'API key').placeholder).toContain('A key is saved');
    await click(checkbox(editor(), 'Remove the saved key'));
    expect(buttonByText(editor(), 'Save profile')!.disabled).toBe(true);
    // Switching to a lend sign-in drops the key too: the engine would use the key first.
    await click(checkbox(editor(), 'A lend sign-in'));
    await pickOption(input(editor(), 'Lend sign-in'), 'acct-lend');
    await click(buttonByText(editor(), 'Save profile'));
    await settle(3);
    expect(api.calls).toContain('keySet("prof-key","")');
  });

  it('needs "I understand" before a teammates profile can be saved, and caps it at 24 hours', async () => {
    await mount();
    await click(buttonByText(host, 'New profile'));
    await typeInto(input(editor(), 'Name'), 'Friends');
    await click(checkbox(editor(), 'Claude'));
    await pickOption(input(editor(), 'Lend sign-in'), 'acct-lend');
    await click(checkbox(editor(), 'Teammates'));
    expect(editor().textContent).toContain('Use at your own risk');
    expect(editor().textContent).toContain('Maya');
    expect(buttonByText(editor(), 'Save profile')!.disabled).toBe(true);
    await click(checkbox(editor(), 'I understand'));
    expect(buttonByText(editor(), 'Save profile')!.disabled).toBe(false);
    const customs = [...editor().querySelectorAll('button')].filter((b) => b.textContent === 'Custom');
    await click(customs[1]);
    await typeInto(editor().querySelectorAll<HTMLInputElement>('input[aria-label="Hours"]')[0], '25');
    expect(editor().textContent).toContain('24 hours at most');
    expect(buttonByText(editor(), 'Save profile')!.disabled).toBe(true);
  });

  it('has a "Keep this PC awake while lending" row, on by default, that is saved when turned off', async () => {
    const { api } = await mount();
    await click(buttonByText(section('Lend profiles'), 'Edit'));
    const row = checkbox(editor(), 'Keep this PC awake while lending');
    expect(row.checked).toBe(true);
    await click(row);
    expect(checkbox(editor(), 'Keep this PC awake while lending').checked).toBe(false);
    await click(buttonByText(editor(), 'Save profile'));
    await settle(3);
    expect(api.calls.find((c) => c.startsWith('profileSave('))).toContain('"keep_awake":false');
  });

  it('edits and deletes a profile', async () => {
    const { api } = await mount();
    await click(buttonByText(section('Lend profiles'), 'Edit'));
    expect(input(editor(), 'Name').value).toBe(MY_PROFILE.name);
    await typeInto(input(editor(), 'Name'), 'Renamed');
    await click(buttonByText(editor(), 'Save profile'));
    await settle(3);
    expect(api.calls.find((c) => c.startsWith('profileSave('))).toContain('"id":"prof-mine"');
    await click(host.querySelector('button[aria-label="Delete Renamed"]'));
    await settle(3);
    expect(api.calls).toContain('profileDelete("prof-mine")');
  });
});

describe('Active lends', () => {
  it('shows both ways with Revoke and Give back, and what the lender used', async () => {
    const { api } = await mount({ grants: [GRANT_OUT, GRANT_IN] });
    const box = section('Active lends');
    expect(box.textContent).toMatch(/Lending Claude to Maya/);
    expect(box.textContent).toMatch(/Borrowing Claude from Sam/);
    expect(box.textContent).toContain('Used so far: 14 requests · 62.1k tokens');
    await click(buttonByText(box, 'Revoke'));
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
