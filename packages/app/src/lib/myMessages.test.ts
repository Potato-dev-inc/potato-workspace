import { describe, expect, it } from 'vitest';
import { mergeMine, ownMatches, withPicked } from './myMessages';

describe('my messages', () => {
  it('lists the chat messages newest first, each once, and filters by the query', () => {
    const history = ['fix the login', 'add tests', 'fix the login', 'Fix the footer'];
    expect(ownMatches(history, '')).toEqual(['Fix the footer', 'fix the login', 'add tests']);
    expect(ownMatches(history, 'FIX')).toEqual(['Fix the footer', 'fix the login']);
  });
  it('puts other chats after the own ones without repeats', () => {
    expect(mergeMine(['a', 'b'], ['b', ' c ', ''])).toEqual(['a', 'b', 'c']);
  });
  it('fills an empty box, and adds after a blank line when the box has text', () => {
    expect(withPicked('  ', 'hello')).toBe('hello');
    expect(withPicked('typed', 'hello')).toBe('typed\n\nhello');
  });
});
