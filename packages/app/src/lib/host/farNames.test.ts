// Two chats of one agent on one PC never share a name, even when the owner numbered some chats and not others.
import { describe, expect, it } from 'vitest';
import { uniqueFarNames } from './farCockpit';

const label = (a: string) => (a === 'claude' ? 'Claude' : a);

describe('uniqueFarNames', () => {
  it('a chat with no owner number that would repeat the owner number takes the next free one', () => {
    const rows = [{ key: 'a', agent: 'claude', nameN: 13 }, { key: 'b', agent: 'claude' }, { key: 'c', agent: 'claude' }];
    const names = new Map([['a', 'Claude 13'], ['b', 'Claude 13'], ['c', 'Claude 13']]);
    uniqueFarNames(names, rows, label);
    expect(names.get('a')).toBe('Claude 13');
    expect(new Set(names.values()).size).toBe(3);
    expect(names.get('b')).toBe('Claude 14');
    expect(names.get('c')).toBe('Claude 15');
  });
  it('leaves distinct names, and other agents, alone', () => {
    const rows = [{ key: 'a', agent: 'claude', nameN: 2 }, { key: 'b', agent: 'claude' }, { key: 'c', agent: 'codex' }];
    const names = new Map([['a', 'Claude 2'], ['b', 'Claude 3'], ['c', 'codex 2']]);
    uniqueFarNames(names, rows, label);
    expect([...names.values()]).toEqual(['Claude 2', 'Claude 3', 'codex 2']);
  });
});
