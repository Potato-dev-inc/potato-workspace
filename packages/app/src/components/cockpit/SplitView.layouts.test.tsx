// @vitest-environment jsdom
// The split view's drop layouts: two chats stacked, three with the third across the full width, and a pane header
// that can be dragged out (to move it). The chat itself is stubbed (it reads the session file).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneInfo } from '@potato-workspace/shared';
import type { CockpitApi } from '../../hooks/useCockpit';
import { cancelDrag, useDrag } from '../dnd/dragStore';
import { SplitView } from './SplitView';
import { NO_BELOW, type SplitBelow } from './split-grid';

vi.mock('../chat/SessionChatPanel', () => ({ SessionChatPanel: ({ paneId }: { paneId: string }) => <div data-testid="chat">{paneId}</div> }));
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
  act(() => cancelDrag());
  act(() => root.unmount());
  host.remove();
});

function fakeApi(): CockpitApi {
  const mk = (id: string) => ({ info: { id, agent_type: 'codex', cwd: 'C:\\work\\shop', title: `Chat ${id}` } as unknown as PaneInfo, status: 'idle' });
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

const slot = (s: string) => host.querySelector<HTMLElement>(`.ck-split-side[data-split-side="${s}"]`);
const chat = (s: string) => slot(s)?.querySelector('[data-testid="chat"]')?.textContent;
async function render(below: SplitBelow, over: Partial<Parameters<typeof SplitView>[0]> = {}) {
  const fns = { onFocus: vi.fn(), onRatio: vi.fn(), onRows: vi.fn(), onClose: vi.fn(), onCloseChat: vi.fn(), onSplitDown: vi.fn() };
  await act(async () => root.render(<SplitView c={fakeApi()} leftId="p1" rightId="p2" focus="left" ratio={0.5} below={below} {...fns} {...over} />));
  return fns;
}

describe('stacked: two chats, one above the other', () => {
  const stacked: SplitBelow = { ...NO_BELOW, stacked: true };

  it('draws the second chat under the first in one full-width column, with a row divider and no side divider', async () => {
    await render(stacked);
    expect(host.querySelectorAll('.ck-split-col').length).toBe(1);
    expect(host.querySelector('.ck-split-col')!.classList.contains('ck-split-col--full')).toBe(true);
    expect([chat('left'), chat('right')]).toEqual(['p1', 'p2']);
    const col = host.querySelector('.ck-split-col')!;
    expect([...col.querySelectorAll('[data-testid="chat"]')].map((e) => e.textContent)).toEqual(['p1', 'p2']);
    expect(host.querySelector('.ck-split-rowdivider')).not.toBeNull();
    expect(host.querySelector('.ck-split-divider')).toBeNull();
  });

  it('each chat has its own close button, and there is no Split down button', async () => {
    const { onCloseChat } = await render(stacked);
    expect(host.querySelectorAll('button[aria-label="Close this chat"]').length).toBe(2);
    await act(async () => slot('right')!.querySelector<HTMLButtonElement>('button[aria-label="Close this chat"]')!.click());
    expect(onCloseChat).toHaveBeenCalledWith('right');
    expect(host.querySelector('button[aria-label="Split down"]')).toBeNull();
  });

  it('the focused chat is full strength', async () => {
    await render(stacked, { focus: 'right' });
    expect(slot('right')!.classList.contains('is-focused')).toBe(true);
    expect(slot('left')!.classList.contains('is-dim')).toBe(true);
  });
});

describe('wide: two chats on top and one across the full width underneath', () => {
  const wide: SplitBelow = { ...NO_BELOW, leftDown: 'p3', wide: true };

  it('puts the third chat in a row of its own under both columns', async () => {
    await render(wide);
    expect([chat('left'), chat('right'), chat('leftDown')]).toEqual(['p1', 'p2', 'p3']);
    const row = host.querySelector('[data-testid="split-wide"]')!;
    expect(row.querySelector('.ck-split-wide-top .ck-split-divider')).not.toBeNull();
    expect(row.querySelector(':scope > .ck-split-rowdivider')).not.toBeNull();
    // The columns on top hold one chat each; the wide chat is not inside a column.
    expect([...host.querySelectorAll('.ck-split-col')].map((c) => c.querySelectorAll('[data-testid="chat"]').length)).toEqual([1, 1]);
    expect(slot('leftDown')!.closest('.ck-split-col')).toBeNull();
  });

  it('every chat can be closed on its own, and the right column can still be split down into a 2 x 2', async () => {
    const { onCloseChat, onSplitDown } = await render(wide);
    expect(host.querySelectorAll('button[aria-label="Close this chat"]').length).toBe(3);
    await act(async () => slot('leftDown')!.querySelector<HTMLButtonElement>('button[aria-label="Close this chat"]')!.click());
    expect(onCloseChat).toHaveBeenCalledWith('leftDown');
    expect(slot('left')!.querySelector('button[aria-label="Split down"]')).toBeNull();
    await act(async () => slot('right')!.querySelector<HTMLButtonElement>('button[aria-label="Split down"]')!.click());
    expect(onSplitDown).toHaveBeenCalledWith('right');
  });

  it('the row divider reports its share through onRows', async () => {
    const { onRows } = await render(wide);
    const divider = host.querySelector<HTMLElement>('[data-testid="split-wide"] > .ck-split-rowdivider')!;
    vi.spyOn(host.querySelector('[data-testid="split-wide"]')!, 'getBoundingClientRect').mockReturnValue({ left: 0, right: 800, top: 0, bottom: 609, width: 800, height: 609, x: 0, y: 0, toJSON() {} } as DOMRect);
    await act(async () => void divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    expect(onRows).toHaveBeenCalledWith('left', expect.any(Number));
  });
});

describe('a pane header is a drag source', () => {
  function Probe() {
    const drag = useDrag();
    return <span data-testid="probe">{drag ? `${drag.payload.kind}:${drag.payload.id}:${drag.payload.label}` : ''}</span>;
  }
  it('dragging the header of a side starts a drag of that pane; a plain click does not', async () => {
    await act(async () =>
      root.render(
        <>
          <SplitView c={fakeApi()} leftId="p1" rightId="p2" focus="left" ratio={0.5} onFocus={() => {}} onRatio={() => {}} onClose={() => {}} />
          <Probe />
        </>,
      ),
    );
    const head = slot('right')!.querySelector<HTMLElement>('.ck-split-head')!;
    const fire = (target: EventTarget, type: string, x: number, y: number) =>
      act(async () => void target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 })));
    await fire(head, 'pointerdown', 10, 10);
    await fire(window, 'pointermove', 12, 11);
    expect(host.querySelector('[data-testid="probe"]')!.textContent).toBe('');
    await fire(window, 'pointermove', 200, 100);
    expect(host.querySelector('[data-testid="probe"]')!.textContent).toBe('tab:p2:Chat p2');
    await fire(window, 'pointerup', 200, 100);
    expect(host.querySelector('[data-testid="probe"]')!.textContent).toBe('');
  });
});
