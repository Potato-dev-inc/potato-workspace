import { describe, expect, it } from 'vitest';
import type { ChatTurn } from './sessionChatModel';
import { fallbackLine, paneTurns, registerPaneTurns, twoLines, watchChange, watchStateOf } from './potatoCheck';

describe('potato check helpers', () => {
  it('keeps two plain lines from a longer answer', () => {
    expect(twoLines('**It is running the tests.**\nIt needs nothing from you.\nExtra line.')).toEqual(['It is running the tests.', 'It needs nothing from you.']);
  });

  it('cuts one paragraph at sentence ends', () => {
    expect(twoLines('It is fixing the login page. It waits for a yes or no. Later it will test.')).toEqual(['It is fixing the login page.', 'It waits for a yes or no.']);
  });

  it('cuts a very long line', () => {
    const [line] = twoLines('x'.repeat(400), 50);
    expect(Array.from(line)).toHaveLength(50);
    expect(line.endsWith('…')).toBe(true);
  });

  it('summarises a pane with no chat from its status', () => {
    expect(fallbackLine('running', false, 'Editing app.ts')).toEqual({ key: 'potato.check.fallback.working', vars: { activity: 'Editing app.ts' } });
    expect(fallbackLine('running', false, null).key).toBe('potato.check.fallback.quiet');
    expect(fallbackLine('idle', true, null).key).toBe('potato.check.fallback.needs');
    expect(fallbackLine('error', false, null).key).toBe('potato.check.fallback.error');
    expect(fallbackLine('idle', false, null).key).toBe('potato.check.fallback.idle');
  });

  it('a watch fires only when the state changes', () => {
    expect(watchChange('working', 'working')).toBeNull();
    expect(watchChange('working', 'needs')).toBe('needs');
    expect(watchChange('working', 'calm')).toBe('done');
    expect(watchChange('calm', 'working')).toBe('working');
    expect(watchChange('needs', 'working')).toBeNull();
    expect(watchStateOf('running', true)).toBe('needs');
    expect(watchStateOf('idle', false)).toBe('calm');
  });

  it('knows a chat only while it is registered and has turns', () => {
    const turns = [{ id: 't1' }] as unknown as ChatTurn[];
    expect(paneTurns('p1')).toBeNull();
    const off = registerPaneTurns('p1', () => turns);
    expect(paneTurns('p1')).toBe(turns);
    off();
    expect(paneTurns('p1')).toBeNull();
    const off2 = registerPaneTurns('p2', () => []);
    expect(paneTurns('p2')).toBeNull();
    off2();
  });
});
