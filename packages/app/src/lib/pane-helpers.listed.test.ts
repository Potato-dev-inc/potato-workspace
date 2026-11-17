import { describe, expect, it } from 'vitest';
import { isListedAgentPane } from './pane-helpers';

// Which chats the keys (next, previous, jump 1-9, next needing you, split) and Search treat as open agents.
describe('isListedAgentPane', () => {
  const none = new Set<string>();
  it('lists a normal chat', () => expect(isListedAgentPane({ id: 'a' }, none)).toBe(true));
  it('never lists a minion run, even a running one', () => expect(isListedAgentPane({ id: 'm', started_as: 'minion' }, new Set(['m']))).toBe(false));
  it('hides a standby chat nobody opened and lists one the person opened', () => {
    expect(isListedAgentPane({ id: 's', standby_seat: 'x' }, none)).toBe(false);
    expect(isListedAgentPane({ id: 's', standby_seat: 'x' }, new Set(['s']))).toBe(true);
  });
});
