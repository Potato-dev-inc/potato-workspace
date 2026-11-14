// @vitest-environment jsdom
// The "flow" screens (update choice, What is new, sign-in fix card, Problems list, error card, start-up line) in Traditional
// Chinese: every key has its zh-TW text, and no screen shows a run of English words.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignInFixCard } from '../components/acp/SignInFixCard';
import { ErrorCard } from '../components/common/ErrorCard';
import { ProblemsChip } from '../components/cockpit/problems/ProblemsChip';
import { StartupCheckLine } from '../components/cockpit/StartupCheckLine';
import { UpdateNoticeView } from '../components/updates/UpdateNotice';
import type { AppUpdateState } from '../components/updates/useAppUpdate';
import { WhatsNewCard } from '../components/updates/WhatsNewCard';
import { reportProblem, resetProblems } from '../lib/problems';
import { rememberWhatsNew } from '../lib/update-schedule';
import { flow as enFlow } from './en/flow';
import { flow as zhFlow } from './zh-TW/flow';
import { useChinese, useEnglish, visibleEnglish } from './test-utils';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  useChinese();
  window.localStorage.clear();
  resetProblems();
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  useEnglish();
});

describe('flow in Traditional Chinese', () => {
  it('every English flow key has a zh-TW text, with the same {placeholders}', () => {
    const holes = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(',');
    const missing = Object.keys(enFlow).filter((k) => !(k in zhFlow));
    expect(missing).toEqual([]);
    const bad = Object.entries(enFlow).filter(([k, v]) => !/_(one|other)$/.test(k) && holes(v) !== holes((zhFlow as Record<string, string>)[k] ?? ''));
    expect(bad.map(([k]) => k)).toEqual([]);
  });

  it('the update choice has no visible English', async () => {
    const state = {
      phase: 'waiting', failure: null, offer: { currentVersion: '1.0.2', version: '1.0.3', notes: null }, busyAgents: ['Claude', 'Codex'], busy: { agents: ['Claude', 'Codex'], chats: ['Claude'], terminals: ['Codex'] },
      percent: null, reading: null, stalled: false, error: null, reopened: false, when: 'tonight', target: new Date(2026, 10, 15, 2, 0).getTime(),
      check: async () => undefined, update: async () => undefined, restartNow: async () => undefined, restartWhenIdle: () => undefined, restartTonight: () => undefined, reopenChats: async () => undefined,
    } as AppUpdateState;
    await act(async () => root.render(<UpdateNoticeView state={state} />));
    expect(host.textContent).toContain('今晚');
    expect(visibleEnglish(host, ['Claude', 'Codex'])).toEqual([]);
  });

  it('What is new has no visible English (the lines themselves come from the release notes)', async () => {
    rememberWhatsNew({ version: '1.0.3', notes: '- 新增功能', chats: 2 });
    await act(async () => root.render(<WhatsNewCard transport={{ currentVersion: async () => '1.0.3' } as never} />));
    expect(host.querySelector('[data-testid="whats-new-card"]')).not.toBeNull();
    expect(visibleEnglish(host)).toEqual([]);
  });

  it('the sign-in fix card has no visible English', async () => {
    await act(async () => root.render(<SignInFixCard label="Claude" kept="新增日期格式" other={{ id: 'codex', label: 'Codex' }} onOpen={vi.fn()} onRetry={vi.fn()} onUseOther={vi.fn()} />));
    expect(host.textContent).toContain('登入已失效');
    expect(visibleEnglish(host)).toEqual([]);
  });

  it('the Problems chip and list have no visible English', async () => {
    reportProblem({ id: 'a', what: 'x', agent: 'Claude', agentId: 'claude', paneId: 'p1', way: 'open_chat' });
    await act(async () => root.render(<ProblemsChip actions={{ openChat: vi.fn(), signIn: vi.fn(), tryAgain: vi.fn() }} />));
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="problems-chip"]')!.click());
    expect(host.textContent).toContain('1 個問題');
    expect(visibleEnglish(host, ['x'])).toEqual([]);
  });

  it('the error card has no visible English', async () => {
    await act(async () => root.render(<ErrorCard what="出錯了" can="再試一次" details="boom" action={{ label: '再試', onClick: vi.fn() }} />));
    expect(visibleEnglish(host)).toEqual([]);
  });

  it('the start-up line has no visible English', async () => {
    vi.useFakeTimers();
    try {
      const deps = {
        agentHealth: async () => [],
        bridgeUp: () => false,
        diskFreeBytes: async () => 1024 ** 3,
        updateReachable: async () => true,
        lanes: async () => null,
        settings: async () => null,
      };
      await act(async () => root.render(<StartupCheckLine deps={deps} bridgeUp={() => false} actions={{ signIn: vi.fn() }} delayMs={10} enabled />));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(host.querySelector('[data-testid="startup-check"]')).not.toBeNull();
      expect(visibleEnglish(host)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
