// @vitest-environment jsdom
// "Bring my chats", step 1: a missing agent says why in one plain line (Not installed, Signed out, No chats found).
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import type { ImportAgent, ImportFound } from '../../lib/chatImport';
import { BringAgentList, missingReason, type AgentStanding } from './BringAgentList';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const found = (id: string, label: string, chats: number): ImportFound => ({
  id, label, fromDefinition: false, chats, bytes: 0, oldestMs: null, newestMs: null, already: 0, tooBig: 0, places: [], canContinue: true,
});
const agent = (id: string, label: string): ImportAgent => ({ id, label, fromDefinition: false, enabled: true });

describe('missingReason', () => {
  it('puts not installed and signed out before "no chats"', () => {
    expect(missingReason('not_installed', true)).toBe('Not installed');
    expect(missingReason('signed_out', true)).toBe('Signed out');
    expect(missingReason('unknown', true)).toBe('No chats found');
    expect(missingReason('unknown', false)).toBe("Can't read its chats yet");
  });
});

describe('BringAgentList', () => {
  it('says why each agent with nothing to bring is missing', () => {
    const host = document.createElement('div');
    const stand: Record<string, AgentStanding> = { b: 'not_installed', c: 'signed_out' };
    act(() => {
      createRoot(host).render(
        <BringAgentList
          found={[found('a', 'Alpha', 4), found('b', 'Beta', 0), found('c', 'Gamma', 0), found('d', 'Delta', 0)]}
          unreadable={[agent('e', 'Echo')]}
          now={0}
          onPick={() => undefined}
          standing={(id) => stand[id] ?? 'unknown'}
        />,
      );
    });
    const sub = (name: string) => [...host.querySelectorAll('li')].find((li) => li.textContent?.includes(name))?.querySelector('.bc-agent-sub')?.textContent;
    expect(sub('Beta')).toBe('Not installed');
    expect(sub('Gamma')).toBe('Signed out');
    expect(sub('Delta')).toBe('No chats found');
    expect(sub('Echo')).toBe("Can't read its chats yet");
  });
});
