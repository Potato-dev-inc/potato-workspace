// @vitest-environment jsdom
// The Inbox error card in Traditional Chinese: title, sentence and fix button come from the catalog.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CockpitApi } from '../../hooks/useCockpit';
import { useChinese, useEnglish, visibleEnglish } from '../../i18n/test-utils';
import { PaneErrorCard } from './InboxError';

const api = vi.hoisted(() => ({ info: null as null | object }));
vi.mock('../../lib/cockpit-api', () => ({
  cockpitApi: { paneRunInfo: () => Promise.resolve(api.info) },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const c = { newAgent: vi.fn(), select: vi.fn() } as unknown as CockpitApi;

async function mount() {
  await act(async () => {
    root.render(createElement(PaneErrorCard, { c, paneId: 'p1', agentType: 'claude', name: 'Claude', project: 'shop', age: 125_000, onOpenDoctor: vi.fn() }));
  });
}

beforeEach(() => {
  useChinese();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useEnglish();
});

describe('Inbox error card (zh-TW)', () => {
  it.each(['AGENT_EXITED', 'WORKSPACE_TRUST_DECLINED', 'AGENT_NOT_INSTALLED', 'PANE_NOT_READY', 'PROMPT_NOT_SUBMITTED', 'SOMETHING_NEW'])(
    'shows no English for %s',
    async (code) => {
      api.info = { handle: 'h', status: 'failed', receipt: null, error: { code } };
      await mount();
      expect(visibleEnglish(host, ['shop', ...code.split('_')])).toEqual([]);
    },
  );

  it('says what happened and the fix in Chinese', async () => {
    api.info = { handle: 'h', status: 'failed', receipt: null, error: { code: 'AGENT_EXITED' } };
    await mount();
    expect(host.querySelector('.ib-title')!.textContent).toBe('Claude 已停止');
    expect(host.querySelector('.ib-reason')!.textContent).toContain('意外關閉');
    expect([...host.querySelectorAll('button')].map((b) => b.textContent)).toContain('重新開始');
  });
});
