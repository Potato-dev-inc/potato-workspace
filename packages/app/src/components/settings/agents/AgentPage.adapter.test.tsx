// @vitest-environment jsdom
// An agent page always has a "Chat adapter" row: an agent the Add-agent wizard installed (no chat yet, not even proof it
// can chat) must offer a way to pick one, and one that has an adapter shows it with Change and Remove. The Labs switch
// does not hide it. Backends are faked at the page's `apis`.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcpLaneView } from '../../../lib/acpChat';
import { makeEnv } from '../test-utils';
import { AgentPage, type AgentPageApis } from './AgentPage';
import type { AgentRow } from './useAgentRows';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// A wizard-added agent: registered from a definition file, the program not found yet, nothing known about chat.
const wizardRow: AgentRow = { id: 'agy', label: 'Agy', icon: null, installed: false, state: 'unchecked', version: null, loginHint: null, canTest: false, caps: null };

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

function apisFor(view: AcpLaneView, extra: Partial<NonNullable<AgentPageApis['chat']>> = {}): AgentPageApis {
  return {
    definitions: { list: async () => ({ sources: [], definitions: [] }), remove: vi.fn() },
    chat: { laneGet: async () => view, overlayDetect: vi.fn(), overlaySet: vi.fn(), overlayRemove: vi.fn(), chatRemove: vi.fn(), ...extra } as NonNullable<AgentPageApis['chat']>,
  };
}

async function show(row: AgentRow, apis: AgentPageApis) {
  await act(async () => root.render(<AgentPage row={row} env={makeEnv()} onBack={() => undefined} apis={apis} />));
  for (let i = 0; i < 6; i++) await act(async () => Promise.resolve());
}
const adapter = () => host.querySelector<HTMLElement>('[data-testid="chat-adapter-agy"]');
const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

describe('Agent page: Chat adapter', () => {
  it('a wizard-added agent with no chat shows None and a way to add one', async () => {
    await show(wizardRow, apisFor({ labs_enabled: true, agents: [], can_add_chat: [{ id: 'agy', label: 'Agy', reason: 'not found on this PC' }] }));
    expect(adapter()?.textContent).toBe('None');
    expect(host.textContent).toContain('Chat adapter');
    expect(button('Add chat for Agy')).not.toBeNull();
    expect(button('Add chat for Agy')?.disabled).toBe(false);
    expect(button('Remove chat for Agy')).toBeNull();
  });

  it('shows the row even when the agent is missing from every list, and with the Labs switch off', async () => {
    await show(wizardRow, apisFor({ labs_enabled: false, agents: [] }));
    expect(adapter()?.textContent).toBe('None');
    expect(button('Add chat for Agy')).not.toBeNull();
  });

  it('an agent with an adapter shows it, with Change and Remove', async () => {
    const chatRemove = vi.fn(async () => ({ labs_enabled: true, agents: [] }) as AcpLaneView);
    await show(
      { ...wizardRow, installed: true },
      apisFor({ labs_enabled: true, agents: [{ id: 'agy', label: 'Agy', lane: 'acp', effective_lane: 'acp', disabled: false, disabled_note: null, overlay: true }] }, { chatRemove }),
    );
    expect(adapter()?.getAttribute('data-current')).toBe('Agy');
    expect(host.textContent).toContain('Added by you');
    expect(button('Change the chat adapter of Agy')).not.toBeNull();
    // Only one Remove chat button on the page (the how-it-opens block leaves it to this row).
    expect(host.querySelectorAll('button[aria-label="Remove chat for Agy"]')).toHaveLength(1);
    await act(async () => button('Remove chat for Agy')!.click());
    const dialog = host.querySelector('[data-testid="remove-chat-dialog"]');
    expect(dialog).not.toBeNull();
    const confirm = [...dialog!.querySelectorAll('button')].find((b) => b.textContent === 'Remove')!;
    await act(async () => confirm.click());
    expect(chatRemove).toHaveBeenCalledWith('agy', { removeAddon: false });
    expect(host.querySelector('[data-testid="remove-chat-dialog"]')).toBeNull();
    expect(adapter()?.textContent).toBe('None');
  });

  it('Add chat opens the dialog that reads the registry', async () => {
    const overlayResolve = vi.fn(async () => ({ ok: true, options: [] }) as never);
    await show(wizardRow, apisFor({ labs_enabled: true, agents: [], can_add_chat: [{ id: 'agy', label: 'Agy' }] }, { overlayResolve }));
    await act(async () => button('Add chat for Agy')!.click());
    expect(overlayResolve).toHaveBeenCalledWith('agy');
  });
});
