// The reviewed-adapter helpers: which key groups still need a key, the phrases and the version note. Fake agent only.
import { describe, expect, it } from 'vitest';
import { missingKeysLine, preferredValue, settingDefaults, unmetGroups, versionNote } from './acpAdapter';

const keys = [
  { env: 'FAKE_A_KEY', label: 'Alpha' },
  { env: 'FAKE_B_KEY', label: 'Beta' },
  { env: 'FAKE_C_KEY', label: 'Gamma' },
];
const st = (env: string, set: boolean) => ({ env, label: env, set, shared: false });

describe('acpAdapter helpers', () => {
  it('one saved key in a group is enough; a group with none is unmet', () => {
    const groups = [['FAKE_A_KEY', 'FAKE_B_KEY']];
    expect(unmetGroups(groups, [st('FAKE_A_KEY', false), st('FAKE_B_KEY', true)])).toEqual([]);
    expect(unmetGroups(groups, [st('FAKE_A_KEY', false), st('FAKE_B_KEY', false)])).toEqual([['FAKE_A_KEY', 'FAKE_B_KEY']]);
    expect(unmetGroups(undefined, [])).toEqual([]);
  });

  it('the missing-key line names the labels with "or", and is null when every group has a key', () => {
    const groups = [['FAKE_A_KEY', 'FAKE_B_KEY', 'FAKE_C_KEY'], ['FAKE_C_KEY']];
    expect(missingKeysLine(groups, [], keys)).toBe('Save a key first: Alpha, Beta or Gamma; Gamma. One of each is enough.');
    expect(missingKeysLine(groups, [st('FAKE_C_KEY', true)], keys)).toBeNull();
  });

  it('the version note appears only when the installed version is known and different', () => {
    expect(versionNote('1.0.0', '1.0.0')).toBeNull();
    expect(versionNote('1.0.0', null)).toBeNull();
    expect(versionNote('1.0.0', '2.0.1')).toContain('2.0.1');
  });

  it('settings start at their defaults', () => {
    expect(settingDefaults([{ env: 'FAKE_MODEL', label: 'Model', default: 'fake/small' }])).toEqual({ FAKE_MODEL: 'fake/small' });
  });
});

describe('preferredValue', () => {
  const setting = {
    env: 'FAKE_MODEL',
    label: 'Model',
    default: 'fake/first',
    options: [
      { value: 'fake/first', label: 'First', needs_key: 'FAKE_A_KEY' },
      { value: 'fake/second', label: 'Second', needs_key: 'FAKE_B_KEY' },
      { value: 'fake/free', label: 'Free', needs_key: null },
    ],
  };
  it('the first choice whose key is saved is preselected, a choice with no key counts', () => {
    expect(preferredValue(setting, [st('FAKE_A_KEY', false), st('FAKE_B_KEY', true)])).toBe('fake/second');
    expect(preferredValue(setting, [st('FAKE_A_KEY', true)])).toBe('fake/first');
    expect(preferredValue({ ...setting, options: [setting.options[0], setting.options[2]] }, [st('FAKE_A_KEY', false)])).toBe('fake/free');
  });
  it('the default stands when no choice fits', () => {
    expect(preferredValue({ ...setting, options: [setting.options[0]] }, [])).toBe('fake/first');
    expect(preferredValue({ env: 'X', label: 'X', default: 'fake/plain' }, [])).toBe('fake/plain');
  });
});
