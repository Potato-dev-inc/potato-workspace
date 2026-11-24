// @vitest-environment jsdom
// Settings > Agents > Add an agent, through the real row: the agents found on this PC are one-click Add buttons, and the
// name box (with its install-command words) is under the collapsed Advanced link, never shown first.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FoundAgent } from '../lib/addAgent';
import { mockAddAgentApi } from '../lib/addAgent.mocks';
import { agentsRows } from './settings/sections/AgentsSection';
import { buttonByText, click, hasText, settle } from './settings/test-utils';
import { AddAgent } from './settings/blocks/AddAgent';
import { addableAgents } from './settings/blocks/AddAgentFound';

const FOUND: FoundAgent[] = [
  { id: 'kimi', displayName: 'Claude', path: 'C:/bin/kimi.exe', version: '1.0.0' } as FoundAgent,
  { id: 'qwen', displayName: 'Codex', path: 'C:/bin/qwen.cmd', version: '0.9.0' } as FoundAgent,
];
const WORDS = 'Or type a name, or paste its install command.';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const mountWith = async (found: FoundAgent[]) => {
  const api = { ...mockAddAgentApi('native_ok'), detectInstalled: async () => found };
  await act(async () => root.render(<AddAgent api={api} />));
  await settle(4);
};
const nameBox = () => host.querySelector('input[aria-label="Agent name"]');

describe('Add an agent on the Agents page', () => {
  it('the row is the first Agents row', () => {
    expect(agentsRows[0].id).toBe('add-agent');
  });

  it('two found agents show two one-click Add buttons, and no name box until Advanced is pressed', async () => {
    await mountWith(FOUND);
    expect(host.querySelectorAll('[data-found]')).toHaveLength(2);
    expect(host.querySelector('[aria-label="Add Claude"]')).toBeTruthy();
    expect(host.querySelector('[aria-label="Add Codex"]')).toBeTruthy();
    expect(nameBox()).toBeNull();
    expect(hasText(host, WORDS)).toBe(false);
    await click(buttonByText(host, 'Advanced'));
    expect(nameBox()).toBeTruthy();
    expect(hasText(host, WORDS)).toBe(true);
  });

  it('with no agent found, the page still offers Advanced and no name box first', async () => {
    await mountWith([]);
    expect(nameBox()).toBeNull();
    expect(buttonByText(host, 'Advanced')).toBeTruthy();
  });
});

describe('what the Add list shows', () => {
  const a = (id: string, path: string): FoundAgent => ({ id, displayName: id, path, kind: 'catalog', version: null });
  it('hides agents that are already added, and shows one row per program', () => {
    const list = [a('claude', 'C:/b/claude.exe'), a('copilot', 'C:/b/copilot.exe'), a('github_copilot', 'C:/b/copilot.cmd'), a('qwen', 'C:/b/qwen.exe')];
    expect(addableAgents(list, new Set(['claude'])).map((f) => f.id)).toEqual(['copilot', 'qwen']);
  });
});
