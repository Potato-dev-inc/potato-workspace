// @vitest-environment jsdom
// The pure parts of phone part 2: the connection word, the events list, messages that wait, the agent rules and the pill.
import { beforeEach, describe, expect, it } from 'vitest';
import { ITEM_HIGH, ITEM_LOW, ITEM_MEDIUM, ITEM_QUESTION } from '../dev/attention-fixtures';
import type { AttentionItem, AttentionSnapshot } from './attention';
import { limitOf, mayAnswer, mayType } from './pane-rule-view';
import { canReach, linkKind, MAX_EVENTS, pushEvent, RECONNECT_MS, readEvents, writeEvents, type LinkEvent } from './phone-link';
import { CACHE_ITEMS, readChatCache, trimForCache, writeChatCache } from './phone-chat-cache';
import { pillFor, quickChoices } from './phone-pill';
import { enqueue, MAX_QUEUED, readQueue, writeQueue } from './phone-queue';
import { platformOf } from './phone-setup';
import type { ChatItem } from './sessionChatModel';

beforeEach(() => localStorage.clear());

describe('the connection word', () => {
  const base = { online: true, ready: true, downSince: null, authFailed: false, now: 100_000 };
  it('is Connected while the PC answers', () => {
    expect(linkKind(base)).toBe('connected');
    expect(canReach('connected')).toBe(true);
  });
  it('is Reconnecting for a short silence and PC asleep after a longer one', () => {
    expect(linkKind({ ...base, ready: false, downSince: 100_000 - 1000 })).toBe('reconnecting');
    expect(linkKind({ ...base, ready: false, downSince: 100_000 - RECONNECT_MS })).toBe('asleep');
    expect(canReach('reconnecting') || canReach('asleep')).toBe(false);
  });
  it('is No internet when the phone itself is offline, whatever the PC did', () => {
    expect(linkKind({ ...base, online: false })).toBe('offline');
    expect(linkKind({ ...base, online: false, ready: false, downSince: 0 })).toBe('offline');
  });
  it('is Link changed when the PC refused the phone, before anything else', () => {
    expect(linkKind({ ...base, authFailed: true })).toBe('changed');
    expect(linkKind({ ...base, authFailed: true, online: false })).toBe('changed');
  });
});

describe('the last connection events', () => {
  it('adds one only when the word changes, and keeps the last 20', () => {
    let list: LinkEvent[] = [];
    list = pushEvent(list, 'connected', 1);
    list = pushEvent(list, 'connected', 2);
    expect(list).toHaveLength(1);
    for (let n = 0; n < 40; n++) list = pushEvent(list, n % 2 ? 'connected' : 'asleep', 10 + n);
    expect(list).toHaveLength(MAX_EVENTS);
    expect(list[list.length - 1].at).toBe(49);
  });
  it('is kept on the phone and read back', () => {
    writeEvents([{ at: 5, kind: 'offline' }]);
    expect(readEvents()).toEqual([{ at: 5, kind: 'offline' }]);
    localStorage.setItem('pm.phone.linkEvents', 'not json');
    expect(readEvents()).toEqual([]);
  });
});

describe('messages that wait for the PC', () => {
  it('are kept per chat and read back', () => {
    const one = enqueue([], 'hello', 1000)!;
    writeQueue('p1', one);
    expect(readQueue('p1').map((m) => m.text)).toEqual(['hello']);
    expect(readQueue('p2')).toEqual([]);
    writeQueue('p1', []);
    expect(readQueue('p1')).toEqual([]);
  });
  it('stop at a small number', () => {
    let list = [] as ReturnType<typeof readQueue>;
    for (let n = 0; n < MAX_QUEUED; n++) list = enqueue(list, `m${n}`, n)!;
    expect(enqueue(list, 'one more', 99)).toBeNull();
  });
});

describe('the rule of one agent', () => {
  it('limits only when the PC says so', () => {
    expect(limitOf(undefined)).toBeNull();
    expect(limitOf({ remote: false, level: 'full' })).toBe('off');
    expect(limitOf({ remote: true, level: 'watch' })).toBe('watch');
    expect(limitOf({ remote: true, level: 'answer' })).toBe('answer');
    expect(limitOf({ remote: true, level: 'full' })).toBeNull();
  });
  it('lets a phone answer at the answer level but not type', () => {
    expect(mayType({ remote: true, level: 'answer' })).toBe(false);
    expect(mayAnswer({ remote: true, level: 'answer' })).toBe(true);
    expect(mayAnswer({ remote: true, level: 'watch' })).toBe(false);
    expect(mayType(undefined)).toBe(true);
  });
});

describe('the needs-you pill', () => {
  const snap = (items: AttentionItem[]): AttentionSnapshot => ({ v: 1, rev: 1, counts: { blocking: items.length, ready: 0 }, items });
  it('shows another agent and counts the rest', () => {
    const pill = pillFor(snap([ITEM_LOW, ITEM_HIGH, ITEM_MEDIUM]), ITEM_LOW.pane!.id)!;
    expect(pill.item.id).toBe(ITEM_HIGH.id);
    expect(pill.more).toBe(1);
  });
  it('shows nothing when only this chat needs you', () => {
    expect(pillFor(snap([ITEM_LOW]), ITEM_LOW.pane!.id)).toBeNull();
    expect(pillFor(null, 'x')).toBeNull();
  });
  it('answers Yes and No on the pill only for a low-risk approval with one allow and one deny', () => {
    expect(quickChoices(ITEM_LOW)).toEqual({ yes: 'allow_once', no: 'deny' });
    expect(quickChoices(ITEM_MEDIUM)).toBeNull();
    expect(quickChoices(ITEM_HIGH)).toBeNull();
    expect(quickChoices(ITEM_QUESTION)).toBeNull();
  });
});

describe('the chat the phone keeps', () => {
  const user = (n: number): ChatItem => ({ kind: 'user', id: `u${n}`, at: null, text: `hello ${n}` });
  const tool: ChatItem = { kind: 'toolCall', id: 'c1', at: null, callId: 'k', name: 'Bash', summary: 'ls' };
  it('keeps only the words and the last items, and reads them back', () => {
    const many = Array.from({ length: CACHE_ITEMS + 30 }, (_, n) => user(n));
    expect(trimForCache([tool, ...many])).toHaveLength(CACHE_ITEMS);
    writeChatCache('p1', [tool, user(1)], 1234);
    const kept = readChatCache('p1')!;
    expect(kept.at).toBe(1234);
    expect(kept.items.map((i) => i.kind)).toEqual(['user']);
    expect(readChatCache('other')).toBeNull();
  });
});

describe('the phone kind', () => {
  it('tells an iPhone from an Android phone', () => {
    expect(platformOf('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe('ios');
    expect(platformOf('Mozilla/5.0 (Linux; Android 14; Pixel 8)')).toBe('android');
    expect(platformOf('Mozilla/5.0 (Windows NT 10.0)')).toBe('other');
  });
});
