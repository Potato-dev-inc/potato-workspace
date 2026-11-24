import { describe, expect, it, vi } from 'vitest';
import { paneOf } from './host/farCockpit';
import { startOnLend } from './startOnLend';

// A far pane's cwd is the folder's NAME ("work-test"): the far PC only knows a project by the opaque id its session list gave.
const row = { key: 'dev:bbbb:p1', paneId: 'p1', title: '', agent: 'claude', status: 'idle' as const, cwd: 'work-test', chat: true, project: 'pa1b2c3d4e5f6a7b' };
const start = () => vi.fn(async (..._a: unknown[]) => ({ pane_id: 'dev:bbbb:p2', agent: 'claude', lane: 'acp' as const }));

describe('startOnLend on a far chat', () => {
  it('names the project by the far id (what the New agent page sends), never by the folder name', async () => {
    const s = start();
    await startOnLend({ start: s, agent: 'claude', info: paneOf('bbbb', 'pm-sandbox', row).info });
    expect(s).toHaveBeenCalledWith('claude', 'pa1b2c3d4e5f6a7b', true, undefined, undefined);
  });
  it('asks for a copy again when the chat worked on one (the row says copy, its cwd is only a name)', async () => {
    const s = start();
    await startOnLend({ start: s, agent: 'claude', info: paneOf('bbbb', 'pm-sandbox', { ...row, copy: true }).info });
    expect(s).toHaveBeenCalledWith('claude', 'pa1b2c3d4e5f6a7b', true, undefined, true);
  });
  it('says so, without calling, when the row has no project id', async () => {
    const s = start();
    await expect(startOnLend({ start: s, agent: 'claude', info: paneOf('bbbb', 'pm-sandbox', { ...row, project: '' }).info })).rejects.toThrow();
    expect(s).not.toHaveBeenCalled();
  });
});
