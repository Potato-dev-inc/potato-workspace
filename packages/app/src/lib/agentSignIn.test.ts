import { describe, expect, it, vi } from 'vitest';
import type { UsageRow, UsageSnapshot } from './usage';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
import { signedInNow, SignInCannotCheck } from './agentSignIn';

const row = (over: Partial<UsageRow>): UsageRow => ({
  agent_id: 'claude',
  label: 'Claude',
  account_id: null,
  account_label: null,
  state: 'ok',
  reason: null,
  windows: [],
  plan: null,
  observed_at_ms: null,
  limited_until_ms: null,
  page: null,
  ...over,
});
const usage = (...rows: UsageRow[]) => ({ snapshot: async (): Promise<UsageSnapshot> => ({ refreshed_at_ms: 0, rows }) });
const proof = (signed_in: boolean | null | undefined) => async () => ({ signed_in });
const NOT_YET = 'The sign-in is not finished yet.';

describe('signedInNow: a real sign, never a row that merely exists', () => {
  it('trusts the desktop when it saw the credential file written since the sign-in started', async () => {
    await expect(signedInNow('claude', 'acc-1', usage(), proof(true))).resolves.toBeUndefined();
  });

  it('is not finished while the desktop sees no credential file and no real reading of this login exists', async () => {
    // A fresh account folder gets an `unknown` row as soon as the agent writes any file into it. That used to count as signed in.
    const rows = usage(row({ account_id: 'acc-1', state: 'unknown' }), row({ account_id: null, state: 'ok' }));
    await expect(signedInNow('claude', 'acc-1', rows, proof(false))).rejects.toThrow(NOT_YET);
    await expect(signedInNow('claude', 'acc-1', usage(row({ account_id: 'acc-1', state: 'expired' })), proof(false))).rejects.toThrow(NOT_YET);
    await expect(signedInNow('claude', 'acc-1', usage(), proof(false))).rejects.toThrow(NOT_YET);
  });

  it('a keychain login has no file: a real reading of exactly this login still tells it is done', async () => {
    await expect(signedInNow('claude', 'acc-1', usage(row({ account_id: 'acc-1', state: 'ok' })), proof(false))).resolves.toBeUndefined();
  });

  it('for a login no folder can show, only a real reading of exactly this login counts', async () => {
    const none = proof(null);
    await expect(signedInNow('claude', 'acc-1', usage(row({ account_id: 'acc-1', state: 'unknown' })), none)).rejects.toBeInstanceOf(SignInCannotCheck);
    await expect(signedInNow('claude', 'acc-1', usage(row({ account_id: 'acc-1', state: 'expired' })), none)).rejects.toThrow(NOT_YET);
    await expect(signedInNow('claude', 'acc-1', usage(), none)).rejects.toThrow(NOT_YET);
    // Another account's good row, or the main login's, is not this account's sign-in.
    await expect(signedInNow('claude', 'acc-1', usage(row({ account_id: 'acc-2', state: 'ok' }), row({ account_id: null, state: 'ok' })), none)).rejects.toThrow(NOT_YET);
    await expect(signedInNow('claude', 'acc-1', usage(row({ account_id: 'acc-1', state: 'ok' })), none)).resolves.toBeUndefined();
    await expect(signedInNow('claude', 'acc-1', usage(row({ account_id: 'acc-1', state: 'limited' })), none)).resolves.toBeUndefined();
  });

  it('the main login (no account) is matched to the main login row only, not to any account of the agent', async () => {
    const none = proof(undefined);
    await expect(signedInNow('claude', null, usage(row({ account_id: 'acc-2', state: 'ok' })), none)).rejects.toThrow(NOT_YET);
    await expect(signedInNow('claude', null, usage(row({ account_id: null, state: 'ok' })), none)).resolves.toBeUndefined();
  });

  it('a fresher credential file does not say signed in while the row of this login is still expired', async () => {
    await expect(signedInNow('claude', 'acc-1', usage(row({ account_id: 'acc-1', state: 'expired' })), proof(true))).rejects.toThrow(NOT_YET);
    // Another account's expired row is not this login's.
    await expect(signedInNow('claude', 'acc-1', usage(row({ account_id: 'acc-2', state: 'expired' })), proof(true))).resolves.toBeUndefined();
    await expect(signedInNow('claude', 'acc-1', usage(row({ account_id: 'acc-1', state: 'ok' })), proof(true))).resolves.toBeUndefined();
  });

  it('an agent that shows no sign-in anywhere (proof null, only an unknown row) is said to be unchecked, not waited for', async () => {
    const only = usage(row({ account_id: 'acc-1', state: 'unknown' }));
    await expect(signedInNow('claude', 'acc-1', only, proof(null))).rejects.toBeInstanceOf(SignInCannotCheck);
    // Proof false (a file agent that has not written its file yet) and no row at all keep waiting.
    await expect(signedInNow('claude', 'acc-1', only, proof(false))).rejects.toThrow(NOT_YET);
    await expect(signedInNow('claude', 'acc-1', usage(), proof(null))).rejects.toThrow(NOT_YET);
  });

  it('an error from the desktop falls back to the usage reading and never to success', async () => {
    const broken = async () => {
      throw new Error('no desktop');
    };
    await expect(signedInNow('claude', 'acc-1', usage(row({ account_id: 'acc-1', state: 'unknown' })), broken)).rejects.toThrow(NOT_YET);
  });
});
