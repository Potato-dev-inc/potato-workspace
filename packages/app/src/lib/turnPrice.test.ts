import { describe, expect, it } from 'vitest';
import { groupTurns, mergeItems, type ChatItem } from './sessionChatModel';
import { hasPrice, turnPrices } from './turnPrice';

const user = (n: number): ChatItem => ({ kind: 'user', id: `u${n}`, at: null, text: `ask ${n}` });
const end = (n: number, ms: number): ChatItem => ({ kind: 'turnEnd', id: `e${n}`, at: null, outcome: 'completed', durationMs: ms });
const tool = (turn: number, i: number, name: string, path: string, writes = false): ChatItem[] => [
  { kind: 'toolCall', id: `c${turn}-${i}`, at: null, callId: `k${turn}-${i}`, name, summary: path, paths: [path], writes },
  { kind: 'toolResult', id: `r${turn}-${i}`, at: null, callId: `k${turn}-${i}`, ok: true, output: 'ok' },
];
const usage = (id: string, input: number, output = 0): ChatItem => ({ kind: 'usage', id, at: null, inputTokens: input, outputTokens: output, contextWindow: null });

function turnOf(n: number, steps: number, ms: number, write = false): ChatItem[] {
  const items: ChatItem[] = [user(n)];
  for (let i = 0; i < steps; i++) items.push(...tool(n, i, write && i === 0 ? 'Edit' : 'Read', `src/f${n}-${i}.ts`, write && i === 0));
  items.push(end(n, ms));
  return items;
}

describe('turnPrices', () => {
  it('counts steps and changed files of a finished turn, and leaves a running turn out', () => {
    const items = [...turnOf(1, 3, 60_000, true), user(2)];
    const prices = turnPrices(groupTurns(items).turns);
    expect(prices.get('u1')).toMatchObject({ steps: 3, files: ['src/f1-0.ts'], durationMs: 60_000, heavy: null });
    expect(prices.has('u2')).toBe(false);
  });

  it('has nothing to say for a turn with no steps', () => {
    const prices = turnPrices(groupTurns(turnOf(1, 0, 4000)).turns);
    expect(hasPrice(prices.get('u1'))).toBe(false);
  });

  it('marks a turn far above the chat usual, and says reading when most steps read files', () => {
    const items = [...turnOf(1, 3, 30_000), ...turnOf(2, 4, 40_000), ...turnOf(3, 3, 35_000), ...turnOf(4, 20, 300_000)];
    const prices = turnPrices(groupTurns(items).turns);
    expect(prices.get('u4')).toMatchObject({ heavy: 'reads', reads: 20 });
    expect(prices.get('u1')?.heavy).toBeNull();
  });

  it('is "long" when the steps are not mostly reads', () => {
    const items = [...turnOf(1, 3, 30_000), ...turnOf(2, 4, 40_000), ...turnOf(3, 3, 35_000)];
    const long: ChatItem[] = [user(4)];
    for (let i = 0; i < 14; i++) long.push(...tool(4, i, 'Bash', `cmd${i}`));
    long.push(end(4, 300_000));
    const prices = turnPrices(groupTurns([...items, ...long]).turns);
    expect(prices.get('u4')?.heavy).toBe('long');
  });

  it('never marks a turn in a young chat (fewer than 3 other turns)', () => {
    const prices = turnPrices(groupTurns([...turnOf(1, 3, 30_000), ...turnOf(2, 30, 600_000)]).turns);
    expect(prices.get('u2')?.heavy).toBeNull();
  });

  it('adds tokens only when the window grew by a real amount', () => {
    const items: ChatItem[] = [
      user(1), ...tool(1, 0, 'Read', 'a'), usage('g1', 4000, 500), end(1, 5000),
      user(2), ...tool(2, 0, 'Read', 'b'), usage('g2', 4200, 520), end(2, 5000),
      user(3), ...tool(3, 0, 'Read', 'c'), usage('g3', 9000, 800), end(3, 5000),
    ];
    // The merge keeps the last usage of each finished turn, so the growth can be told.
    const prices = turnPrices(groupTurns(mergeItems([], items, false)).turns);
    expect(prices.get('u1')?.tokens).toBe(4500);
    expect(prices.get('u2')?.tokens).toBeNull();
    expect(prices.get('u3')?.tokens).toBe(5080);
  });
});

describe('mergeItems keeps the last usage of each turn', () => {
  it('drops the other usage items', () => {
    const items: ChatItem[] = [user(1), usage('a', 1), usage('b', 2), end(1, 1), user(2), usage('c', 3), usage('d', 4)];
    const ids = mergeItems([], items, false).filter((i) => i.kind === 'usage').map((i) => i.id);
    expect(ids).toEqual(['b', 'd']);
  });
});
