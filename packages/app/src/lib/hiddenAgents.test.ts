// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LS_HIDDEN_AGENTS, canHideAgent, readHiddenAgents, visibleAgentEntries, withAgentHidden, writeHiddenAgents } from './hiddenAgents';

const ENTRIES = [
  { type: 'claude', label: 'Claude' },
  { type: 'codex', label: 'Codex' },
  { type: 'aider', label: 'Aider' },
  { type: 'powershell', label: 'PowerShell' },
];

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe('hidden agents storage', () => {
  it('reads nothing hidden when nothing was saved', () => {
    expect(readHiddenAgents()).toEqual([]);
  });

  it('keeps only text ids, without repeats, and never throws on broken storage', () => {
    localStorage.setItem(LS_HIDDEN_AGENTS, JSON.stringify(['aider', 'aider', '', 7, null, 'codex']));
    expect(readHiddenAgents()).toEqual(['aider', 'codex']);
    localStorage.setItem(LS_HIDDEN_AGENTS, '{not json');
    expect(readHiddenAgents()).toEqual([]);
    localStorage.setItem(LS_HIDDEN_AGENTS, JSON.stringify({ aider: true }));
    expect(readHiddenAgents()).toEqual([]);
  });

  it('round-trips a write', () => {
    writeHiddenAgents(['aider', 'aider', 'codex']);
    expect(readHiddenAgents()).toEqual(['aider', 'codex']);
  });

  it('tells the other places in the window when it changes', () => {
    let told = 0;
    const listener = () => (told += 1);
    window.addEventListener('pm:hidden-agents-changed', listener);
    writeHiddenAgents(['aider']);
    window.removeEventListener('pm:hidden-agents-changed', listener);
    expect(told).toBe(1);
  });
});

describe('withAgentHidden', () => {
  it('hides an id once and shows it again', () => {
    expect(withAgentHidden([], 'aider', true)).toEqual(['aider']);
    expect(withAgentHidden(['aider'], 'aider', true)).toEqual(['aider']);
    expect(withAgentHidden(['aider', 'codex'], 'aider', false)).toEqual(['codex']);
    expect(withAgentHidden(['codex'], 'aider', false)).toEqual(['codex']);
  });
});

describe('visibleAgentEntries', () => {
  it('leaves out the hidden agents and keeps the order', () => {
    expect(visibleAgentEntries(ENTRIES, ['aider']).map((e) => e.type)).toEqual(['claude', 'codex', 'powershell']);
  });

  it('shows everything when nothing is hidden', () => {
    expect(visibleAgentEntries(ENTRIES, [])).toHaveLength(4);
  });

  it('shows everything again when every agent is hidden, so the menu is never empty', () => {
    expect(visibleAgentEntries(ENTRIES, ENTRIES.map((e) => e.type))).toHaveLength(4);
  });

  it('ignores hidden ids the list no longer has', () => {
    expect(visibleAgentEntries(ENTRIES, ['gone'])).toHaveLength(4);
  });
});

describe('canHideAgent', () => {
  it('allows hiding while another agent stays shown', () => {
    expect(canHideAgent(ENTRIES, [], 'aider')).toBe(true);
    expect(canHideAgent(ENTRIES, ['claude', 'codex'], 'aider')).toBe(true);
  });

  it('refuses to hide the last shown agent', () => {
    expect(canHideAgent(ENTRIES, ['claude', 'codex', 'powershell'], 'aider')).toBe(false);
  });

  it('refuses when the only other shown agent is the one being hidden', () => {
    expect(canHideAgent([{ type: 'claude', label: 'Claude' }], [], 'claude')).toBe(false);
  });
});
