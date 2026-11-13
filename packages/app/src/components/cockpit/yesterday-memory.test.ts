// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import type { PaneInfo } from '../../lib/tauri-types';
import { ACP_LANE } from '../../lib/acpChat';
import {
  YESTERDAY_KEY,
  YESTERDAY_MAX_CHATS,
  dayWordOf,
  forgetPreviousRunForTests,
  parseYesterday,
  pendingChats,
  previousRun,
  snapshotNow,
  type YesterdaySnapshot,
} from './yesterday-memory';

const chat = (id: string, extra: Partial<PaneInfo> = {}): PaneInfo => ({ id, agent_type: 'codex', cwd: `/work/${id}`, lane: ACP_LANE, ...extra }) as PaneInfo;
const term = (id: string): PaneInfo => ({ id, agent_type: 'claude', cwd: '/work/t' }) as PaneInfo;

describe('parseYesterday', () => {
  it('reads nothing as no snapshot, and drops bad pieces without throwing', () => {
    expect(parseYesterday(null)).toBeNull();
    expect(parseYesterday('not json')).toBeNull();
    expect(parseYesterday(JSON.stringify({ savedAt: 'x', chats: [] }))).toBeNull();
    const parsed = parseYesterday(
      JSON.stringify({
        savedAt: 5,
        chats: [{ id: 'a', agent: 'codex', cwd: '/a' }, { id: 'a', agent: 'codex', cwd: '/a' }, { id: '', agent: 'x', cwd: '' }, null, { id: 'b', agent: 'claude', cwd: '/b', title: 'Hi' }],
        split: { left: 'a', right: 'b', ratio: 2 },
      }),
    );
    expect(parsed?.chats.map((c) => c.id)).toEqual(['a', 'b']);
    expect(parsed?.chats[1].title).toBe('Hi');
    expect(parsed?.split).toEqual({ left: 'a', right: 'b', ratio: 0.5 });
  });

  it('keeps at most the chat limit', () => {
    const many = Array.from({ length: YESTERDAY_MAX_CHATS + 5 }, (_, i) => ({ id: `c${i}`, agent: 'codex', cwd: '/w' }));
    expect(parseYesterday(JSON.stringify({ savedAt: 1, chats: many, split: null }))?.chats).toHaveLength(YESTERDAY_MAX_CHATS);
  });
});

describe('snapshotNow', () => {
  it('keeps only chat panes, in tab order', () => {
    const snap = snapshotNow([term('t1'), chat('b'), chat('a', { title: '  Fix login  ' }), chat('h', { parent_pane_id: 'b' })], null, 9);
    expect(snap.savedAt).toBe(9);
    expect(snap.chats.map((c) => c.id)).toEqual(['b', 'a']);
    expect(snap.chats[1].title).toBe('Fix login');
  });

  it('keeps the split only when both sides are open chats', () => {
    const panes = [chat('a'), chat('b'), term('t1')];
    expect(snapshotNow(panes, { left: 'a', right: 'b', ratio: 0.4 }, 1).split).toEqual({ left: 'a', right: 'b', ratio: 0.4 });
    expect(snapshotNow(panes, { left: 'a', right: 't1', ratio: 0.4 }, 1).split).toBeNull();
  });
});

describe('pendingChats', () => {
  const snap: YesterdaySnapshot = {
    savedAt: 1,
    chats: [
      { id: 'a', agent: 'codex', cwd: '/a', title: null },
      { id: 'b', agent: 'codex', cwd: '/b', title: null },
      { id: 'c', agent: 'codex', cwd: '/c', title: null },
    ],
    split: null,
  };

  it('offers chats that are not open and still closed; never a deleted one', () => {
    const got = pendingChats(snap, new Set(['b']), new Set(['a', 'b']));
    expect(got.map((c) => c.id)).toEqual(['a']);
  });

  it('is empty without a snapshot', () => {
    expect(pendingChats(null, new Set(), new Set(['a']))).toEqual([]);
  });
});

describe('dayWordOf', () => {
  it('says today, yesterday, or nothing for older times', () => {
    const now = new Date(2026, 10, 13, 9, 0).getTime();
    expect(dayWordOf(new Date(2026, 10, 13, 1, 0).getTime(), now)).toBe('today');
    expect(dayWordOf(new Date(2026, 10, 12, 23, 59).getTime(), now)).toBe('yesterday');
    expect(dayWordOf(new Date(2026, 10, 11, 12, 0).getTime(), now)).toBeNull();
  });
});

describe('previousRun', () => {
  beforeEach(() => {
    localStorage.clear();
    forgetPreviousRunForTests();
  });

  it('reads the stored snapshot once, so later writes do not change it', () => {
    localStorage.setItem(YESTERDAY_KEY, JSON.stringify({ savedAt: 3, chats: [{ id: 'a', agent: 'codex', cwd: '/a' }], split: null }));
    const first = previousRun();
    expect(first?.chats[0].id).toBe('a');
    localStorage.setItem(YESTERDAY_KEY, JSON.stringify({ savedAt: 4, chats: [], split: null }));
    expect(previousRun()?.savedAt).toBe(3);
  });
});
