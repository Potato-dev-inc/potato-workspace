// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClosedChat, ClosedChatsApi } from '../../../lib/closedChats';
import type { SplitMemory } from '../split-memory';
import type { YesterdaySnapshot } from '../yesterday-memory';
import { ContinueCard, freshBrief, type ContinueYesterdayProps } from './ContinueCard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date(2026, 10, 13, 9, 0).getTime();
const SAVED = new Date(2026, 10, 12, 18, 42).getTime();

const closed = (id: string, title: string, cwd: string): ClosedChat => ({ id, agent: 'codex', label: 'Codex', cwd, updated_ms: 1, title });

const previous: YesterdaySnapshot = {
  savedAt: SAVED,
  chats: [
    { id: 'a', agent: 'codex', cwd: '/work/alpha', title: null },
    { id: 'b', agent: 'codex', cwd: '/work/beta', title: null },
  ],
  split: { left: 'a', right: 'b', ratio: 0.6 },
};

function fakeApi(over: { closed?: ClosedChat[]; reopen?: (id: string) => Promise<string> } = {}) {
  const reopen = vi.fn(over.reopen ?? (async (id: string) => id));
  const api = {
    list: async () => over.closed ?? [closed('a', 'Fix login', '/work/alpha'), closed('b', 'Add tests', '/work/beta')],
    reopen,
    remove: vi.fn(),
    removeAll: vi.fn(),
    watch: async () => () => undefined,
  } as unknown as ClosedChatsApi;
  return { api, reopen };
}

describe('ContinueCard', () => {
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

  const flush = async () => {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  };
  const render = async (props: Partial<ContinueYesterdayProps> & { api: ClosedChatsApi }) => {
    const onReopened = vi.fn();
    const onFresh = vi.fn();
    await act(async () => {
      root.render(<ContinueCard previous={previous} openIds={[]} onReopened={onReopened} onFresh={onFresh} now={NOW} {...props} />);
    });
    await flush();
    return { onReopened, onFresh };
  };
  const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label);
  const click = async (el: Element | undefined) => {
    expect(el).toBeTruthy();
    await act(async () => {
      (el as HTMLButtonElement).click();
    });
    await flush();
  };

  it('shows the card with the chats that did not come back, and the time', async () => {
    const { api } = fakeApi();
    await render({ api });
    expect(host.querySelector('[data-testid="continue-card"]')).not.toBeNull();
    expect(host.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
    expect(host.textContent).toContain('Yesterday');
    expect(host.textContent).toContain('Fix login');
  });

  it('shows nothing when every chat is open, or there is no snapshot', async () => {
    const { api } = fakeApi();
    await render({ api, openIds: ['a', 'b'] });
    expect(host.querySelector('[data-testid="continue-card"]')).toBeNull();
    await render({ api, previous: null });
    expect(host.querySelector('[data-testid="continue-card"]')).toBeNull();
  });

  it('reopens all of them and hands back the split they had', async () => {
    const { api, reopen } = fakeApi();
    const { onReopened } = await render({ api });
    await click(button('Reopen all 2'));
    expect(reopen).toHaveBeenCalledTimes(2);
    const split: SplitMemory = { left: 'a', right: 'b', ratio: 0.6 };
    expect(onReopened).toHaveBeenCalledWith(['a', 'b'], split);
  });

  it('reopens only the ticked ones, with no split when one is left out', async () => {
    const { api, reopen } = fakeApi();
    const { onReopened } = await render({ api });
    const second = host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1];
    await act(async () => {
      second.click();
    });
    await flush();
    await click(button('Reopen 1 ticked'));
    expect(reopen.mock.calls.map((c) => c[0])).toEqual(['a']);
    expect(onReopened).toHaveBeenCalledWith(['a'], null);
  });

  it('gives a chat that cannot reopen a fresh-start row, which fills the message box', async () => {
    const { api } = fakeApi({
      reopen: async (id) => {
        if (id === 'b') throw new Error('agent off');
        return id;
      },
    });
    const { onReopened, onFresh } = await render({ api });
    await click(button('Reopen all 2'));
    expect(host.querySelector('[data-testid="continue-failed-row"]')).not.toBeNull();
    expect(onReopened).toHaveBeenCalledWith(['a'], null);
    await click(button('Start fresh with a short brief'));
    expect(onFresh).toHaveBeenCalledWith(freshBrief(previous.chats[1], 'Add tests'));
    expect(onFresh.mock.calls[0][0]).toContain('Add tests');
    expect(onFresh.mock.calls[0][0]).toContain('beta');
    expect(host.querySelector('[data-testid="continue-failed-row"]')).toBeNull();
  });

  it('hides for the rest of the session on Hide', async () => {
    const { api } = fakeApi();
    await render({ api });
    await click(button('Hide'));
    expect(host.querySelector('[data-testid="continue-card"]')).toBeNull();
  });
});
