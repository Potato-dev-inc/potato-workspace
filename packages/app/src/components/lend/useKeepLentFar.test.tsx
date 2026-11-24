// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GRANT_OUT } from '../../dev/lend-fixtures';
import type { OwnAgentsApi } from '../../lib/host/ownAgents';
import type { Grant } from '../../lib/lend';
import type { LendHandle } from './useLend';
import { useKeepLentFar } from './useKeepLentFar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement('div');
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
});

const grant = (over: Partial<Grant>): Grant => ({ ...GRANT_OUT, id: 'lg1', peer_node: 'aa', pane_ids: ['dev:aa:p1'], ends_ms: Date.now() + 3600_000, ...over });
const handle = (grants: Grant[]): LendHandle => ({ state: { enabled: true, profiles: [], grants, requests_in: [], requests_out: [], drivers: [] }, enabled: true, known: true, now: Date.now(), refresh: () => undefined });
function Probe({ lend, open, api }: { lend: LendHandle; open: string[]; api: OwnAgentsApi }) {
  useKeepLentFar(lend, open, api, 1000);
  return null;
}
const api = (): OwnAgentsApi & { renew: ReturnType<typeof vi.fn> } => ({ offer: vi.fn(), notePane: vi.fn(), renew: vi.fn(async () => Date.now() + 12 * 3600_000) });

describe('keeping a lent far chat going', () => {
  it('rolls the lend on while a chat on it is open, and not when none is', async () => {
    const a = api();
    await act(async () => root.render(<Probe lend={handle([grant({})])} open={['dev:aa:p1']} api={a} />));
    expect(a.renew).toHaveBeenCalledWith('lg1');
    const b = api();
    await act(async () => root.render(<Probe lend={handle([grant({})])} open={['dev:aa:other']} api={b} />));
    await act(async () => vi.advanceTimersByTime(2500));
    expect(b.renew).not.toHaveBeenCalled();
  });

  it('leaves alone a lend with lots of time left, one that is not to my own PC, and one that is mine to borrow', async () => {
    const a = api();
    const lend = handle([grant({ id: 'long', ends_ms: Date.now() + 12 * 3600_000 }), grant({ id: 'team', peer_node: '' }), grant({ id: 'in', direction: 'in' })]);
    await act(async () => root.render(<Probe lend={lend} open={['dev:aa:p1']} api={a} />));
    await act(async () => vi.advanceTimersByTime(2500));
    expect(a.renew).not.toHaveBeenCalled();
  });
});
