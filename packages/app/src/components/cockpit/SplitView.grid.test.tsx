// @vitest-environment jsdom
// The split view as a 2x2 grid: where the chats sit, the close and Split down buttons, the focus, and the dividers
// that resize a column. The chat itself is stubbed (it reads the session file).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneInfo } from '@potato-workspace/shared';
import type { CockpitApi } from '../../hooks/useCockpit';
import { SplitView, focusSideComposer } from './SplitView';
import { NO_BELOW, type SplitBelow } from './split-grid';

vi.mock('../chat/SessionChatPanel', () => ({
  SessionChatPanel: ({ paneId }: { paneId: string }) => (
    <div data-testid="chat">
      {paneId}
      <textarea aria-label={`message ${paneId}`} />
    </div>
  ),
}));
vi.mock('./rail/SessionRail', () => ({ SessionRail: () => null }));
vi.mock('../../lib/agentRegistry', () => ({ useAgentRegistry: () => ({ agents: [] }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function fakeApi(): CockpitApi {
  const mk = (id: string) => ({ info: { id, agent_type: 'codex', cwd: 'C:\\work\\shop', title: null } as unknown as PaneInfo, status: 'idle' });
  const panes = ['p1', 'p2', 'p3', 'p4'].map(mk);
  return {
    registry: { paneList: panes, panes: new Map(panes.map((p) => [p.info.id, p])), initialReady: true },
    names: new Map(),
    asked: { questions: [] },
    prompts: {},
    selectedId: 'p1',
    select: vi.fn(),
    notify: vi.fn(),
  } as unknown as CockpitApi;
}

const FOUR: SplitBelow = { leftDown: 'p3', rightDown: 'p4', leftRows: 0.5, rightRows: 0.5 };
const slot = (s: string) => host.querySelector<HTMLElement>(`.ck-split-side[data-split-side="${s}"]`);
const chat = (s: string) => slot(s)?.querySelector('[data-testid="chat"]')?.textContent;

async function render(over: Partial<Parameters<typeof SplitView>[0]> = {}) {
  const fns = { onFocus: vi.fn(), onRatio: vi.fn(), onRows: vi.fn(), onClose: vi.fn(), onCloseChat: vi.fn(), onSplitDown: vi.fn() };
  await act(async () => root.render(<SplitView c={fakeApi()} leftId="p1" rightId="p2" focus="left" ratio={0.5} below={FOUR} {...fns} {...over} />));
  return fns;
}

describe('split view grid', () => {
  it('shows four chats, two in each column, in their places', async () => {
    await render();
    expect([chat('left'), chat('right'), chat('leftDown'), chat('rightDown')]).toEqual(['p1', 'p2', 'p3', 'p4']);
    const cols = [...host.querySelectorAll('.ck-split-col')];
    expect(cols.map((c) => [...c.querySelectorAll('[data-testid="chat"]')].map((e) => e.textContent))).toEqual([
      ['p1', 'p3'],
      ['p2', 'p4'],
    ]);
    expect(slot('left')!.classList.contains('ck-split-side-top')).toBe(true);
    expect(slot('leftDown')!.classList.contains('ck-split-side-top')).toBe(false);
  });

  it('with no chats below it is the two-chat split: no row divider, no extra close buttons', async () => {
    await render({ below: NO_BELOW, onSplitDown: undefined, onCloseChat: undefined });
    expect(host.querySelectorAll('.ck-split-side').length).toBe(2);
    expect(host.querySelector('.ck-split-rowdivider')).toBeNull();
    expect(host.querySelector('button[aria-label="Close this chat"]')).toBeNull();
    expect(host.querySelector('button[aria-label="Close split view"]')).not.toBeNull();
  });

  it('every chat in a grid has its own close button, which closes just that chat', async () => {
    const { onCloseChat, onClose } = await render();
    expect(host.querySelectorAll('button[aria-label="Close this chat"]').length).toBe(4);
    await act(async () => slot('rightDown')!.querySelector<HTMLButtonElement>('button[aria-label="Close this chat"]')!.click());
    expect(onCloseChat).toHaveBeenCalledWith('rightDown');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('the Split down button is on a top chat whose column is free, and asks for that column', async () => {
    const below: SplitBelow = { ...NO_BELOW, leftDown: 'p3' };
    const { onSplitDown } = await render({ below });
    expect(slot('left')!.querySelector('button[aria-label="Split down"]')).toBeNull();
    expect(slot('leftDown')!.querySelector('button[aria-label="Split down"]')).toBeNull();
    const btn = slot('right')!.querySelector<HTMLButtonElement>('button[aria-label="Split down"]')!;
    await act(async () => btn.click());
    expect(onSplitDown).toHaveBeenCalledWith('right');
  });

  it('there is no Split down button once four chats are open', async () => {
    await render();
    expect(host.querySelector('button[aria-label="Split down"]')).toBeNull();
  });

  it('a click on a lower chat focuses it, and only the focused one is full strength', async () => {
    const { onFocus } = await render({ focus: 'rightDown' });
    expect(slot('rightDown')!.classList.contains('is-focused')).toBe(true);
    expect(slot('left')!.classList.contains('is-dim')).toBe(true);
    await act(async () => slot('leftDown')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(onFocus).toHaveBeenCalledWith('leftDown');
  });

  it('focusSideComposer reaches a chat below', async () => {
    await render();
    act(() => focusSideComposer('rightDown'));
    expect(document.activeElement).toBe(host.querySelector('[aria-label="message p4"]'));
  });

  it('names each place for screen readers', async () => {
    await render();
    expect(slot('leftDown')!.getAttribute('aria-label')).toMatch(/^Bottom left chat: /);
    expect(slot('right')!.getAttribute('aria-label')).toMatch(/^Right chat: /);
  });
});

describe('split view row dividers', () => {
  // Each column is 800px tall, so its two chats share 791px (the divider is 9px).
  const SPAN = 791;
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect);
  });
  afterEach(() => vi.restoreAllMocks());
  const rows = () => [...host.querySelectorAll<HTMLElement>('.ck-split-rowdivider')];
  const pointer = (type: string, clientY = 0) => new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientY });

  it('one divider per column that holds two chats, as a horizontal separator showing the share', async () => {
    await render({ below: { ...FOUR, leftRows: 0.3 } });
    expect(rows().length).toBe(2);
    expect(rows()[0].getAttribute('role')).toBe('separator');
    expect(rows()[0].getAttribute('aria-orientation')).toBe('horizontal');
    expect(rows()[0].getAttribute('aria-valuenow')).toBe('30');
    expect(rows()[0].tabIndex).toBe(0);
    await render({ below: { ...NO_BELOW, rightDown: 'p4' } });
    expect(rows().length).toBe(1);
  });

  it('Up and Down arrows move it 24px, and a double-click goes back to even', async () => {
    const { onRows } = await render({ below: { ...FOUR, leftRows: 0.7 } });
    await act(async () => rows()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })));
    expect(onRows).toHaveBeenLastCalledWith('left', expect.closeTo(0.7 - 24 / SPAN, 9));
    await act(async () => rows()[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    expect(onRows).toHaveBeenLastCalledWith('right', expect.closeTo(0.5 + 24 / SPAN, 9));
    await act(async () => rows()[0].dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    expect(onRows).toHaveBeenLastCalledWith('left', 0.5);
  });

  it('a drag follows the pointer and each chat keeps at least 160px', async () => {
    const { onRows } = await render();
    await act(async () => rows()[0].dispatchEvent(pointer('pointerdown', 400)));
    await act(async () => rows()[0].dispatchEvent(pointer('pointermove', 300)));
    expect(onRows).toHaveBeenLastCalledWith('left', expect.closeTo((300 - 4.5) / SPAN, 9));
    await act(async () => rows()[0].dispatchEvent(pointer('pointermove', 0)));
    expect(onRows).toHaveBeenLastCalledWith('left', expect.closeTo(160 / SPAN, 9));
    await act(async () => rows()[0].dispatchEvent(pointer('pointermove', 790)));
    expect(onRows).toHaveBeenLastCalledWith('left', expect.closeTo(1 - 160 / SPAN, 9));
  });
});
