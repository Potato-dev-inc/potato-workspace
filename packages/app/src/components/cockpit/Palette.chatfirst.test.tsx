// @vitest-environment jsdom
// The command palette with "Show terminals" OFF: "New <agent>" rows only for agents that can chat, no shell rows, and a click
// goes through the cockpit's chat-first start. With terminals shown the list is as before.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitApi } from '../../hooks/useCockpit';
import type { AcpLaneView } from '../../lib/acpChat';
import { forceShowTerminals } from '../../lib/showTerminals';
import { Palette } from './Palette';

let lanes: AcpLaneView | null = null;
vi.mock('../../hooks/useAcpLanes', () => ({ useAcpLanes: () => lanes }));
vi.mock('../TerminalViewport', () => ({ TerminalViewport: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = NoopResizeObserver;
Element.prototype.scrollIntoView = () => {};

const newAgent = vi.fn(async () => 'p9' as string | null);
const cockpit = (): CockpitApi =>
  ({
    registry: { paneList: [], panes: new Map(), initialReady: true },
    names: new Map(),
    activities: {},
    previews: {},
    asked: { questions: [] },
    prompts: {},
    statusSince: new Map(),
    now: 0,
    selectedId: null,
    spawn: null,
    mode: 'orchestration',
    theme: 'dark',
    launchEntries: [
      { type: 'claude', label: 'Claude', icon: null },
      { type: 'aider', label: 'Aider', icon: null },
      { type: 'powershell', label: 'PowerShell', icon: null, shell: true },
    ],
    readyAgents: new Set(),
    bridgeLine: '',
    select: vi.fn(),
    notify: vi.fn(),
    newAgent,
  }) as unknown as CockpitApi;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  newAgent.mockClear();
  lanes = { labs_enabled: true, agents: [{ id: 'claude', label: 'Claude', lane: 'terminal', effective_lane: 'terminal', disabled: false, disabled_note: null }] };
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  forceShowTerminals(true);
  act(() => root.unmount());
  host.remove();
});

const rows = () => [...host.querySelectorAll<HTMLElement>('button, [role="option"]')].map((e) => e.textContent ?? '');
const row = (text: string) => [...host.querySelectorAll<HTMLElement>('button, [role="option"]')].find((e) => e.textContent?.includes(text));

describe('the command palette with terminals hidden', () => {
  it('offers New <agent> only for agents that can chat, and no shell', () => {
    forceShowTerminals(false);
    act(() => root.render(<Palette c={cockpit()} onClose={() => {}} />));
    expect(rows().some((r) => r.includes('New Claude'))).toBe(true);
    expect(rows().some((r) => r.includes('New Aider'))).toBe(false);
    expect(rows().some((r) => r.includes('New PowerShell'))).toBe(false);
  });

  it('a click starts through the cockpit (which starts a chat while terminals are hidden)', () => {
    forceShowTerminals(false);
    act(() => root.render(<Palette c={cockpit()} onClose={() => {}} />));
    act(() => row('New Claude')!.click());
    expect(newAgent).toHaveBeenCalledWith('claude');
  });

  it('with terminals shown every agent and the shell are listed, as before', () => {
    forceShowTerminals(true);
    act(() => root.render(<Palette c={cockpit()} onClose={() => {}} />));
    expect(rows().some((r) => r.includes('New Aider'))).toBe(true);
    expect(rows().some((r) => r.includes('New PowerShell'))).toBe(true);
  });
});
