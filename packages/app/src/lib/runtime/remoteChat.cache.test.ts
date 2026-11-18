// @vitest-environment jsdom
// What this PC keeps of another PC's chats: at most 200 items per chat, at most 20 chats (the least recently used go first),
// and nothing of a PC once it is removed.
import { beforeEach, describe, expect, it } from 'vitest';
import { CACHE_KEEP, CACHE_MAX_CHATS, clearRemoteChatCache, readCache, writeCache } from './remoteChat';
import type { ChatItem } from '../sessionChatModel';

const item = (n: number) => ({ id: `i${n}`, kind: 'assistant', text: `t${n}` }) as unknown as ChatItem;
const items = (n: number) => Array.from({ length: n }, (_, i) => item(i));
const stored = (key: string) => window.localStorage.getItem(`pm.remoteChat.${key}`);

beforeEach(() => window.localStorage.clear());

describe('the kept transcripts of other PCs', () => {
  it('keeps only the last 200 items of one chat', () => {
    writeCache('device:n1:p1', items(CACHE_KEEP + 50));
    const back = readCache('device:n1:p1');
    expect(back).toHaveLength(CACHE_KEEP);
    expect((back[CACHE_KEEP - 1] as unknown as { id: string }).id).toBe(`i${CACHE_KEEP + 49}`);
  });

  it('keeps at most 20 chats and drops the least recently used first', () => {
    for (let i = 0; i < CACHE_MAX_CHATS; i += 1) writeCache(`device:n1:p${i}`, items(2));
    // p0 is read again and written: it is now the newest, so p1 is the oldest.
    writeCache('device:n1:p0', items(3));
    writeCache('device:n1:extra', items(2));
    expect(stored('device:n1:p1')).toBeNull();
    expect(stored('device:n1:p0')).not.toBeNull();
    expect(stored('device:n1:extra')).not.toBeNull();
    const keys = Object.keys(window.localStorage).filter((k) => k.startsWith('pm.remoteChat.device:'));
    expect(keys).toHaveLength(CACHE_MAX_CHATS);
  });

  it('clears everything of one PC and nothing of another when it is removed', () => {
    writeCache('device:n1:p1', items(2));
    writeCache('device:n1:p2', items(2));
    writeCache('device:n2:p1', items(2));
    window.localStorage.setItem('pm.remoteChat.device:n1:old', '[]'); // written before the index existed
    clearRemoteChatCache('n1');
    expect(stored('device:n1:p1')).toBeNull();
    expect(stored('device:n1:p2')).toBeNull();
    expect(stored('device:n1:old')).toBeNull();
    expect(stored('device:n2:p1')).not.toBeNull();
    writeCache('device:n3:p1', items(1));
    expect(JSON.parse(window.localStorage.getItem('pm.remoteChat.__index')!)).toEqual(['device:n2:p1', 'device:n3:p1']);
  });
});
