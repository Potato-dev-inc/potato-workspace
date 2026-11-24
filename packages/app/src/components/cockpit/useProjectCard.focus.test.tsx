// @vitest-environment jsdom
// The branch of an agent's folder is read again when the window gets the focus back (a repo removed or a branch switched outside the app).
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { usePaneCards, type CardApi } from './useProjectCard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('asks the branch again on focus, and a removed repo no longer has one', async () => {
  let branch: string | null = 'main';
  const api = { paneGitBranch: vi.fn(async () => branch), paneWorktree: vi.fn(async () => null) } as unknown as CardApi;
  const seen: Array<string | null | undefined> = [];
  const panes = [{ id: 'p1', status: 'idle' }];
  function Probe() {
    seen.push(usePaneCards(panes, api).get('p1')?.branch);
    return null;
  }
  const host = document.createElement('div');
  const root = createRoot(host);
  const settle = () => act(async () => { await new Promise((r) => setImmediate(r)); });
  await act(async () => root.render(<Probe />));
  await settle();
  expect(seen.at(-1)).toBe('main');
  branch = null;
  await act(async () => { window.dispatchEvent(new Event('focus')); });
  await settle();
  expect(seen.at(-1)).toBeNull();
  expect(api.paneGitBranch).toHaveBeenCalledTimes(2);
  act(() => root.unmount());
});
