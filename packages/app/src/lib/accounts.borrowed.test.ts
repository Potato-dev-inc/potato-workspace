import { describe, expect, it } from 'vitest';
import { agentChoices, sendBlock } from '../components/cockpit/newagent/model';
import { accountsFor, needsAccountStep, pickableAccounts, rememberedSignIn, signInLabel, type Account, type AccountsOverview } from './accounts';

const NOW = 1_000_000_000_000;
const MIN = 60_000;

const own: Account = { id: 'acct-work', agent_id: 'claude', label: 'Work', home: 'C:\\work' };
const lendOnly: Account = { id: 'acct-lend', agent_id: 'claude', label: 'Lend login', home: 'C:\\lend', lend_only: true };
const overview: Pick<AccountsOverview, 'accounts' | 'borrowed'> = {
  accounts: [own, lendOnly],
  borrowed: [
    { id: 'lend:g1', agent_id: 'claude', label: "Leo's PC (lent)", ends_ms: NOW + 134 * MIN, grant_id: 'g1' },
    { id: 'lend:g0', agent_id: 'claude', label: "Old PC (lent)", ends_ms: NOW - MIN, grant_id: 'g0' },
  ],
};

describe('a borrowed lend is one more sign-in', () => {
  it('is listed after my own logins, a lend-only login is left out, and a lend that ran out is gone', () => {
    const list = pickableAccounts(overview, NOW);
    expect(list.map((a) => a.id)).toEqual(['acct-work', 'lend:g1']);
    expect(list[1]).toMatchObject({ agent_id: 'claude', borrowed: true, ends_ms: NOW + 134 * MIN });
    expect(accountsFor(list, 'claude')).toHaveLength(2);
    // An old backend has no `borrowed` list at all.
    expect(pickableAccounts({ accounts: [own] }, NOW).map((a) => a.id)).toEqual(['acct-work']);
  });

  it('a borrowed login alone is enough to ask which sign-in to use', () => {
    expect(needsAccountStep([], 'claude')).toBe(false);
    expect(needsAccountStep(pickableAccounts({ accounts: [], borrowed: overview.borrowed }, NOW), 'claude')).toBe(true);
    // Only a lend-only login: it is for lending, not for starting.
    expect(needsAccountStep(pickableAccounts({ accounts: [lendOnly] }, NOW), 'claude')).toBe(false);
  });

  it('is named "<Peer>\'s PC (lent) · 2h 14m left", my own as they are', () => {
    const [, borrowed] = pickableAccounts(overview, NOW);
    expect(signInLabel(borrowed, NOW)).toBe("Leo's PC (lent) · 2h 14m left");
    expect(signInLabel(borrowed, NOW + 100 * MIN)).toBe("Leo's PC (lent) · 34m left");
    expect(signInLabel(own, NOW)).toBe('Work');
  });

  it('is remembered while it runs and forgotten when it ends', () => {
    const list = pickableAccounts(overview, NOW);
    const found = rememberedSignIn(list, 'claude', { claude: 'lend:g1' }, NOW);
    expect(found).toEqual({ accountId: 'lend:g1', label: "Leo's PC (lent) · 2h 14m left" });
    expect(rememberedSignIn(list, 'claude', { claude: 'lend:g1' }, NOW + 135 * MIN)).toBeNull();
    expect(rememberedSignIn(list, 'claude', { claude: 'acct-work' }, NOW)).toEqual({ accountId: 'acct-work', label: 'Work' });
  });

  it('shows in the New agent page choices with its countdown, and can start a chat too', () => {
    const live = pickableAccounts({ accounts: [own], borrowed: [{ id: 'lend:g1', agent_id: 'claude', label: "Leo's PC (lent)", ends_ms: Date.now() + 134 * MIN, grant_id: 'g1' }] });
    const choices = agentChoices([{ id: 'claude', label: 'Claude', installed: true, kind: 'agent', modes: { visible: true, headless: true } } as never], live);
    expect(choices.map((c) => c.key)).toEqual(['claude', 'claude:acct-work', 'claude:lend:g1']);
    expect(choices[2].label).toMatch(/^Claude · Leo's PC \(lent\) · 2h 1\dm left$/);
    const borrowed = choices[2];
    expect(sendBlock({ prompt: 'hi', choice: borrowed, runAs: 'terminal', folder: 'C:\\p', busy: false })).toBeNull();
    expect(sendBlock({ prompt: 'hi', choice: borrowed, runAs: 'chat', folder: 'C:\\p', busy: false })).toBeNull();
  });
});
