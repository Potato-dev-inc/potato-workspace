import { describe, expect, it } from 'vitest';
import { earliestAnchor, prependItems } from './chatMore';
import type { ChatItem } from './sessionChatModel';

const user = (id: string): ChatItem => ({ kind: 'user', id, at: null, text: id });
const session: ChatItem = { kind: 'session', id: 'session', at: null, model: 'm', cliVersion: null };

describe('Show earlier helpers', () => {
  it('the anchor is the first message or step, not the session line that always has the same id', () => {
    expect(earliestAnchor([session, user('u5'), user('u6')])).toBe('u5');
    expect(earliestAnchor([session])).toBeNull();
    expect(earliestAnchor([])).toBeNull();
  });

  it('older items go in front, in order, and an item held already keeps its newest copy and the older place', () => {
    const held = [session, { ...user('u5'), text: 'newest copy' } as ChatItem, user('u6')];
    const merged = prependItems(held, [session, user('u3'), user('u4'), user('u5')]);
    expect(merged.map((i) => i.id)).toEqual(['session', 'u3', 'u4', 'u5', 'u6']);
    expect((merged[3] as { text: string }).text).toBe('newest copy');
  });
});
