// @vitest-environment jsdom
// The chat starting skeleton: a quiet, chat-shaped view with the agent and the folder, announced as a status.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatStartingView } from './ChatStartingView';

vi.mock('../../lib/agentRegistry', () => ({
  useAgentRegistry: () => [],
  agentLabel: (_listing: unknown, id: string) => (id === 'codex' ? 'Codex' : id),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('ChatStartingView', () => {
  it('says the agent is starting, names the folder, and shows a disabled composer', () => {
    act(() => root.render(<ChatStartingView start={{ agentId: 'codex', folder: 'C:\\work\\shop' }} />));
    const status = host.querySelector('[role="status"]');
    expect(status?.textContent).toContain('Starting Codex');
    expect(status?.textContent).toContain('shop');
    expect(status?.textContent).toContain('Starting...');
    expect(host.querySelectorAll('.ck-chat-start-row')).toHaveLength(3);
  });
});
