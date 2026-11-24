// @vitest-environment jsdom
// Screen level (P4a): Ctrl+Shift+F also asks the other PCs that are online. Their hits sit in the same list, newest first, with the PC's
// name on the meta line; a hit of a far chat opens that chat on its PC (the same screen as from the Projects list); a hit the PC no longer lists opens the read-only card.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitApi } from '../../hooks/useCockpit';
import type { ChatHit } from '../../lib/chatSearch';
import { ALL_CAPS, type Host } from '../../lib/host/host';
import { Palette } from './Palette';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  Element.prototype.scrollIntoView = vi.fn();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

const hit = (extra: Partial<ChatHit> = {}): ChatHit => ({ paneId: 'p1', session: 's1', itemId: '1:0', kind: 'assistant', agent: 'codex', folder: 'shop', atMs: Date.now() - 600_000, snippet: 'deploy script', marks: [[0, 6]], ...extra });

const farHost = (hits: ChatHit[]): Host => ({
  place: { kind: 'pc', node: 'n1', name: 'Mac mini' },
  live: true,
  caps: ALL_CAPS,
  invoke: (async () => ({ enabled: true, hits })) as Host['invoke'],
  listen: async () => () => undefined,
});

function cockpit(): CockpitApi {
  const info = { id: 'p1', agent_type: 'codex', status: 'idle', cwd: 'C:\work\shop', title: null };
  return { registry: { paneList: [{ info, status: 'idle' }], panes: new Map([['p1', { info, status: 'idle' }]]) }, launchEntries: [], readyAgents: new Set(), names: new Map(), selectedId: null, mode: 'orchestration', theme: 'dark', previews: {}, openSettings: vi.fn(async () => {}), notify: vi.fn(), select: vi.fn() } as unknown as CockpitApi;
}

function type(text: string) {
  const input = host.querySelector<HTMLInputElement>('input')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('Palette: Search all chats across PCs', () => {
  it('lists this PC\'s hit and the far PC\'s hit together, the far one marked with the PC\'s name', async () => {
    invokeMock.mockImplementation(async (cmd: string) => (cmd === 'chat_search' ? { enabled: true, hits: [hit({ snippet: 'my deploy', atMs: Date.now() - 900_000 })] } : cmd === 'chat_search_facets' ? { agents: [], folders: [] } : null));
    act(() => root.render(<Palette c={cockpit()} onClose={() => {}} initialMode="chats" farHosts={[farHost([hit({ paneId: 'p9', snippet: 'far deploy' })])]} />));
    type('deploy');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    const rows = [...host.querySelectorAll('[role="option"]')].map((r) => r.textContent ?? '');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('far deploy');
    expect(rows[0]).toContain('Mac mini');
    expect(rows[1]).toContain('my deploy');
    expect(rows[1]).not.toContain('Mac mini');
  });

  it('a far hit opens the far chat under its key when its PC lists it, and the read-only card when it does not', async () => {
    invokeMock.mockImplementation(async (cmd: string) => (cmd === 'chat_search' ? { enabled: true, hits: [] } : cmd === 'chat_search_facets' ? { agents: [], folders: [] } : null));
    for (const listed of [true, false]) {
      const c = cockpit();
      const openFar = vi.fn(() => listed);
      const onClose = vi.fn();
      act(() => root.render(<Palette c={c} onClose={onClose} initialMode="chats" openFar={openFar} farHosts={[farHost([hit({ paneId: 'p9', snippet: 'far deploy' })])]} />));
      type('deploy');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      act(() => host.querySelector<HTMLElement>('[role="option"]')!.click());
      expect(openFar).toHaveBeenCalledWith('dev:n1:p9');
      expect(onClose).toHaveBeenCalledTimes(listed ? 1 : 0);
      expect(c.select).not.toHaveBeenCalled();
      // The read-only card replaces the list while it shows.
      expect(host.querySelector('#ck-palette-list')!.hasAttribute('hidden')).toBe(!listed);
    }
  });

  it('with a far chat on screen, Undo last turn is for that chat, never for the chat of this PC that is selected', async () => {
    const onUndo = vi.fn();
    act(() => root.render(<Palette c={cockpit()} onClose={() => {}} onUndoLastTurn={onUndo} farSelected="dev:n1:p9" />));
    type('Undo last turn');
    const rows = [...host.querySelectorAll<HTMLElement>('[role="option"]')].filter((r) => r.textContent?.includes('Undo last turn'));
    expect(rows).toHaveLength(1);
    act(() => rows[0]!.click());
    expect(onUndo).toHaveBeenCalledWith('dev:n1:p9');
  });
});
