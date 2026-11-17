// @vitest-environment jsdom
// Search (Ctrl K): a standby's own chat and a minion's run are never listed as open agents.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitApi } from '../../hooks/useCockpit';
import { Palette } from './Palette';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const opened = vi.hoisted(() => ({ set: new Set<string>() }));
vi.mock('../../lib/standbyHelpers', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../lib/standbyHelpers')>()), useOpenedStandbyPanes: () => opened.set }));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  opened.set = new Set();
  Element.prototype.scrollIntoView = vi.fn();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const mk = (id: string, extra: Record<string, unknown> = {}) => ({
  info: { id, agent_type: 'opencode', status: 'idle', cwd: 'C:\work\shop', title: `Chat ${id}`, created_at: 1, ...extra },
  status: 'idle',
});

function cockpit(list: ReturnType<typeof mk>[]): CockpitApi {
  return {
    registry: { paneList: list, panes: new Map(list.map((p) => [p.info.id, p])) },
    launchEntries: [],
    readyAgents: new Set(),
    names: new Map(list.map((p) => [p.info.id, 'OpenCode'])),
    selectedId: null,
    mode: 'orchestration',
    theme: 'dark',
    previews: {},
    openSettings: vi.fn(),
    notify: vi.fn(),
    select: vi.fn(),
  } as unknown as CockpitApi;
}

describe('Palette: runs of standbys and minions', () => {
  it('still lists a standby chat the person opened, but not a minion that is running', () => {
    opened.set = new Set(['seat1']);
    const c = cockpit([mk('main'), mk('minion1', { started_as: 'minion', title: 'Minion check' }), mk('seat1', { standby_seat: 's1', title: 'Seat chat' }), mk('seat2', { standby_seat: 's2', title: 'Other seat' })]);
    const noop = vi.fn();
    act(() => root.render(<Palette c={c} onClose={noop} onUndoLastTurn={noop} onOpenMemory={noop} onOpenTeam={noop} onOpenPlans={noop} onOpenStore={noop} onOpenReview={noop} onOpenShortcuts={noop} />));
    const text = Array.from(host.querySelectorAll('[role="option"]')).map((r) => r.textContent ?? '').join('|');
    expect(text).toContain('Seat chat');
    expect(text).not.toContain('Other seat');
    expect(text).not.toContain('Minion check');
  });

  it('lists the person\u2019s agents but not a minion or a standby seat chat', () => {
    const c = cockpit([mk('main'), mk('minion1', { started_as: 'minion', title: 'Minion check' }), mk('seat1', { standby_seat: 's1', title: 'Seat chat' })]);
    const noop = vi.fn();
    act(() => root.render(<Palette c={c} onClose={noop} onUndoLastTurn={noop} onOpenMemory={noop} onOpenTeam={noop} onOpenPlans={noop} onOpenStore={noop} onOpenReview={noop} onOpenShortcuts={noop} />));
    const text = Array.from(host.querySelectorAll('[role="option"]')).map((r) => r.textContent ?? '').join('|');
    expect(text).toContain('Chat main');
    expect(text).not.toContain('Minion check');
    expect(text).not.toContain('Seat chat');
  });
});
