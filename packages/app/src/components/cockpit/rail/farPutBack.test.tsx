// @vitest-environment jsdom
// A far chat: Put back in the review drops the file from the Outputs and Changes cards too, through the real far hooks (the host's own calls),
// although the chat's write events name the file with the far PC's full path and the card's cwd is not that PC's folder.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HostProvider } from '../../../lib/host/context';
import type { Host } from '../../../lib/host/host';
import { resetReviewMarks } from '../../../lib/turn-review';
import { useEnglish } from '../../../i18n/test-utils';
import { resetUndoBar } from '../../../lib/undo-bar';
import { TurnFiles } from '../turnfiles/TurnFiles';
import { ChangesSection } from './ChangesSection';
import { OutputsSection } from './OutputsSection';
import { resetRailFoldForTests } from './railFold';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REVIEW = { turn: 1, beforeId: '3', afterId: '4', truncated: false, files: [{ path: 'r11.txt', status: 'A', added: 1, deleted: 0, binary: false, blob: 'b1' }] };
const calls: string[] = [];
const far = {
  place: { kind: 'pc', node: 'n1', name: 'pm-sandbox' },
  live: true,
  caps: { watch: true, message: true, answer: true, change: true, start: true },
  listen: async () => () => undefined,
  // The far PC keeps listing the file in the turn's review: only the put back mark can hide it.
  invoke: vi.fn(async (cmd: string) => {
    calls.push(cmd);
    if (cmd === 'checkpoint_turn_review') return REVIEW;
    if (cmd === 'checkpoint_put_back') return { safetyId: '9', action: 'removed' };
    return null;
  }),
} as unknown as Host;
const outputs = [{ path: '/home/u/work-test/r11.txt', tool: 'Write', wrote: true as const }];

let el: HTMLDivElement;
let root: Root;
beforeEach(() => {
  useEnglish();
  window.localStorage.clear();
  resetRailFoldForTests();
  resetReviewMarks();
  resetUndoBar();
  calls.length = 0;
  el = document.createElement('div');
  el.className = 'cockpit';
  document.body.appendChild(el);
  root = createRoot(el);
});
afterEach(() => {
  act(() => root.unmount());
  el.remove();
});

describe('far chat Put back', () => {
  it('drops the file from Outputs and Changes', async () => {
    await act(async () =>
      root.render(
        <HostProvider host={far}>
          <TurnFiles paneId="far:n1:12" status="idle" />
          <OutputsSection paneId="far:n1:12" cwd="C:/Users/me/placeholder" outputs={outputs} />
          <ChangesSection paneId="far:n1:12" status="idle" cwd="C:/Users/me/placeholder" outputs={outputs} canCreatePr={false} showDone={false} />
        </HostProvider>,
      ),
    );
    await act(async () => {
      await new Promise((r) => setImmediate(r));
    });
    expect(el.querySelector('[data-testid="rail-changes-total"]')).not.toBeNull();
    const btn = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Put back')!;
    await act(async () => {
      btn.click();
      await new Promise((r) => setImmediate(r));
    });
    expect(calls).toContain('checkpoint_put_back');
    expect(el.querySelector('[data-testid="rail-changes-total"]')).toBeNull();
    expect(el.textContent).not.toMatch(/rail-out|r11\.txt\s*Note/);
    expect([...el.querySelectorAll('.rp-row.rp-btn')].some((b) => b.getAttribute('title')?.endsWith('r11.txt'))).toBe(false);
  });
});
