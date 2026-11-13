// The chip rules are pure: a chip follows the capability, and a yes or no with no source is shown as not seen yet.
import { describe, expect, it } from 'vitest';
import { chipViews, shownValue, terminalOnly, type AgentCaps, type Cap } from './agentCaps';

const cap = (value: Cap['value'], source: Cap['source']): Cap => ({ value, source, proof: value === 'unknown' ? '' : 'x', at: null });
const none = cap('unknown', 'unknown');
const caps = (over: Partial<AgentCaps>): AgentCaps =>
  ({
    schema: 1, agent_id: 'a', label: 'A', level: 'l0', level_proof: none, program_version: null, chat: none, resume: none, shows_steps: none,
    edits_files: none, asks_before_edit: none, asks_before_shell: none, model_pick: none, models: [], models_total: 0, stop: none, images: none,
    usage: none, read_only: none, ...over,
  }) as AgentCaps;

describe('agent chips', () => {
  it('a value with no source is not seen yet', () => {
    expect(shownValue(cap('yes', 'unknown'))).toBe('unknown');
    expect(shownValue(cap('no', 'unknown'))).toBe('unknown');
    expect(shownValue(undefined)).toBe('unknown');
    expect(shownValue(cap('yes', 'seen'))).toBe('yes');
    expect(shownValue(cap('no', 'check'))).toBe('no');
  });

  it('puts yes first, then no, then the ones not seen yet, in the spec order', () => {
    const { known, unknown } = chipViews(caps({ chat: cap('yes', 'definition'), usage: cap('yes', 'seen'), resume: cap('no', 'handshake') }));
    expect(known.map((c) => c.key)).toEqual(['chat', 'usage', 'resume']);
    expect(unknown).toHaveLength(7);
    expect(unknown[0].key).toBe('shows_steps');
  });

  it('terminal only means the app has proof it cannot chat', () => {
    expect(terminalOnly(caps({ chat: cap('no', 'check') }))).toBe(true);
    expect(terminalOnly(caps({}))).toBe(false);
    expect(terminalOnly(null)).toBe(false);
  });
});
