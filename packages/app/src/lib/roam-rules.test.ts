import { describe, expect, it } from 'vitest';
import { applyAllow, cell, checkAllowList, checkTexts } from './roam-rules';

const rules = (texts: string[], screen = '') => checkTexts(texts, screen).map((h) => h.rule);

describe('roam rules', () => {
  it('passes plain text', () => {
    expect(checkTexts(['Inbox', 'Needs sign in', 'Start a new agent', '3 agents running'])).toEqual([]);
  });

  it('finds banned words from the glossary', () => {
    expect(rules(['Open login pane'])).toContain('banned-term');
    expect(rules(['Chat (ACP)'])).toContain('banned-term');
    expect(rules(['Welcome to Puppet Master'])).toContain('banned-term');
  });

  it('finds raw errors', () => {
    for (const t of [
      "Cannot read properties of null (reading 'map')",
      'Hello [object Object]',
      'Used undefined',
      'Budget NaN%',
      'value is null',
      'TypeError: x is not a function',
      'Error: spawn failed',
      'Err(NotFound)',
      'Saved to C:\\Work\\notes.txt',
      'Saved to /home/sam/notes.txt',
      'at run (http://localhost:1420/src/a.ts:1:2)',
    ])
      expect(rules([t]), t).toContain('raw-error');
  });

  it('does not call ordinary words raw errors', () => {
    expect(rules(['Nullable fields', 'Errors this week', 'Unknown'])).toEqual([]);
  });

  it('finds literal backticks, the dev build line and codes in capitals', () => {
    expect(rules(['Run `claude` and log in'])).toContain('backtick');
    expect(rules(['This is a dev build'])).toContain('dev-build');
    expect(rules(['Status: NEEDS_SIGN_IN'])).toContain('caps-code');
    expect(rules(['USB', 'API', 'PR'])).toEqual([]);
  });

  it('finds two names for one thing', () => {
    expect(rules(['Lend an agent', 'Share an agent'])).toContain('synonym');
    expect(rules(['Dismiss', 'Discard'])).toContain('synonym');
    expect(rules(['New agent', 'Make something'], 'simple-home')).toEqual([]);
    expect(rules(['New agent', 'Make something'], 'cockpit-empty')).toContain('synonym');
  });

  it('reports each hit once', () => {
    expect(checkTexts(['value is null', 'value is null'])).toHaveLength(1);
  });

  it('applies the allow list by rule, screen and text', () => {
    const hits = checkTexts(['value is null', 'Run `x`']);
    const r = applyAllow(hits, 'terminal-a', [{ rule: 'raw-error', screen: '^terminal-', text: 'null', reason: 'terminal output' }]);
    expect(r.allowed.map((h) => h.rule)).toEqual(['raw-error']);
    expect(r.open.map((h) => h.rule)).toEqual(['backtick']);
    expect(applyAllow(hits, 'cockpit', [{ rule: 'raw-error', screen: '^terminal-', reason: 'x' }]).open).toHaveLength(2);
  });

  it('checks the allow list itself', () => {
    expect(checkAllowList([{ rule: 'raw-error', reason: 'ok' }])).toEqual([]);
    expect(checkAllowList([{ rule: 'raw-error' }])).toHaveLength(1);
    expect(checkAllowList([{ rule: 'nope', reason: 'x' }])).toHaveLength(1);
    expect(checkAllowList([{ rule: 'raw-error', screen: '(', reason: 'x' }])).toHaveLength(1);
    expect(checkAllowList({})).toHaveLength(1);
  });

  it('escapes table cells', () => {
    expect(cell('a|b\nc')).toBe('a\\|b c');
  });
});
