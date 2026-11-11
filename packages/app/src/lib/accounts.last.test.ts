// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { LAST_SIGN_IN_KEY, parseLastSignIns, readLastSignIns, rememberSignIn, rememberedSignIn, type Account } from './accounts';

const acc = (id: string, agent = 'claude'): Account => ({ id, agent_id: agent, label: id.toUpperCase(), home: '' });

beforeEach(() => localStorage.clear());

describe('last sign-in per agent', () => {
  it('drops anything that is not an object of strings', () => {
    expect(parseLastSignIns(null)).toEqual({});
    expect(parseLastSignIns('[1]')).toEqual({});
    expect(parseLastSignIns('{x')).toEqual({});
    expect(parseLastSignIns('{"claude":"a","codex":5}')).toEqual({ claude: 'a' });
  });
  it('remembers per agent, the default as an empty value', () => {
    rememberSignIn('claude', 'a');
    rememberSignIn('codex', undefined);
    expect(readLastSignIns()).toEqual({ claude: 'a', codex: '' });
    expect(localStorage.getItem(LAST_SIGN_IN_KEY)).toContain('claude');
  });
  it('uses the remembered one only while it still exists', () => {
    const accounts = [acc('a'), acc('b')];
    expect(rememberedSignIn(accounts, 'claude', {})).toBeNull();
    expect(rememberedSignIn(accounts, 'claude', { claude: 'b' })).toEqual({ accountId: 'b', label: 'B' });
    expect(rememberedSignIn(accounts, 'claude', { claude: '' })).toEqual({ accountId: undefined, label: 'Default' });
    expect(rememberedSignIn(accounts, 'claude', { claude: 'gone' })).toBeNull();
    expect(rememberedSignIn([acc('a', 'codex')], 'claude', { claude: 'a' })).toBeNull();
  });
  it('does not throw when storage is blocked', () => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error('full');
    };
    try {
      expect(() => rememberSignIn('claude', 'a')).not.toThrow();
    } finally {
      Storage.prototype.setItem = set;
    }
  });
});
