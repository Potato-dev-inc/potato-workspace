// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StopReport } from '../../lib/loop-guard';
import { tauriLoopApi } from '../../lib/loop-guard';
import { PanicSheet } from './PanicSheet';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const names = { get: () => undefined } as never;

function report(agents: number): StopReport {
  return {
    stopped: Array.from({ length: agents }, (_, i) => ({ pane_id: `p${i}`, agent_type: 'claude', cwd: '/p' })),
    failed: [],
  } as unknown as StopReport;
}

let host: HTMLDivElement;
let root: Root;

async function show(agents: number) {
  await act(async () => root.render(<PanicSheet report={report(agents)} names={names} onClose={() => {}} />));
  await act(async () => {});
}

const rowTexts = () => Array.from(document.querySelectorAll('.ck-panic-list .ck-panic-name')).map((n) => n.textContent);

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('PanicSheet: Everything is stopped', () => {
  it('lists only what was running, in plain words', async () => {
    await show(3);
    expect(document.querySelector('#ck-panic-t')?.textContent).toBe('Everything is stopped');
    expect(rowTexts()).toEqual(['3 agents stopped']);
  });

  it('leaves out rows for things that were not running', async () => {
    await show(1);
    expect(rowTexts()).toEqual(['1 agent stopped']);
  });

  it('shows Done only', async () => {
    await show(2);
    const labels = Array.from(document.querySelectorAll('button')).map((b) => b.textContent);
    expect(labels).toEqual(['Done']);
  });
});

describe('PanicSheet: an agent that could not be stopped', () => {
  const failedReport = {
    stopped: [{ pane_id: 'p0', agent_type: 'claude', cwd: '/p' }],
    failed: [
      ['p1', 'ACP_DOWN: the agent pipe closed (os error 32)'],
      ['p2', 'timed out'],
    ],
  } as unknown as StopReport;
  const named = { get: (id: string) => (id === 'p1' ? 'Research' : undefined) } as never;

  async function showFailed() {
    await act(async () => root.render(<PanicSheet report={failedReport} names={named} onClose={() => {}} />));
    await act(async () => {});
  }

  it('names the agents that failed in plain words, never the raw reasons', async () => {
    await showFailed();
    expect(document.querySelector('.ck-panic')!.textContent).toContain('Could not stop 2 agents.');
    expect(rowTexts()).toEqual(['1 agent stopped', 'Research', 'An agent']);
    expect(document.body.textContent).not.toContain('ACP_DOWN');
    expect(document.body.textContent).not.toContain('os error 32');
    expect(document.body.textContent).not.toContain('timed out');
  });

  it('Try again asks for the same stop-all again, and the failure is replaced by its answer', async () => {
    const stopAll = vi.spyOn(tauriLoopApi, 'stopAll').mockResolvedValue({ stopped: [], failed: [] } as unknown as StopReport);
    try {
      await showFailed();
      const retry = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Try again')!;
      expect(retry).toBeDefined();
      await act(async () => retry.click());
      await act(async () => {});
      expect(stopAll).toHaveBeenCalledTimes(1);
      expect(document.querySelector('.ck-panic')!.textContent).not.toContain('Could not stop');
      expect(document.querySelector('.ck-panic')!.textContent).toContain('Nothing was running.');
      expect(Array.from(document.querySelectorAll('button')).map((b) => b.textContent)).toEqual(['Done']);
    } finally {
      stopAll.mockRestore();
    }
  });
});
