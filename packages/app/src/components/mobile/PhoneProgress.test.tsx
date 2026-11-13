// @vitest-environment jsdom
// P11 on the phone: while an agent works, one live line under the header says what it does now, which step it is on and how many
// minutes it has worked; where the steps are not known it shows only the time and the last action. The drawer row shows the same.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PHONE_PANES } from '../../dev/phone-fixtures';
import { PANE_CODEX } from '../../dev/fixtures';
import { setLanguagePref } from '../../i18n';
import type { BridgeClient } from '../../lib/bridge-types';
import type { ChatItem, ChatSource, PhoneChatReply } from '../../lib/sessionChatModel';
import { resetProgressForTests } from '../../lib/phone-progress';
import { PhoneChatView } from './PhoneChatView';
import { PhoneDrawer } from './PhoneDrawer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const NOW = Date.parse('2026-11-13T12:10:00.000Z');

beforeEach(() => {
  setLanguagePref('en', false);
  localStorage.clear();
  resetProgressForTests();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const minutesAgo = (n: number) => new Date(NOW - n * 60_000).toISOString();
function liveItems(started: string | null): ChatItem[] {
  return [
    { kind: 'user', id: '1:0', at: started, text: 'Review the bridge auth change' },
    { kind: 'toolCall', id: '2:0', at: null, callId: 'c1', name: 'Read', summary: 'bridge/http.rs', paths: ['bridge/http.rs'] },
    { kind: 'toolResult', id: '3:0', at: null, callId: 'c1', ok: true, output: '' },
    { kind: 'toolCall', id: '4:0', at: null, callId: 'c2', name: 'Edit', summary: 'bridge/http.rs', paths: ['bridge/http.rs'], writes: true },
  ];
}
function bridgeFor(items: ChatItem[], source: ChatSource = 'file') {
  const reply: PhoneChatReply = { available: true, reason: null, source, waitingFor: null, rev: 1, reset: false, items };
  return { paneChat: vi.fn(async () => reply) } as unknown as BridgeClient;
}
async function mount(bridge: BridgeClient, working = true) {
  await act(async () => {
    root.render(<PhoneChatView bridge={bridge} paneId={PANE_CODEX} canWatch canType working={working} />);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(50);
  });
}
const line = () => host.querySelector('[data-testid="phone-progress"]');

describe('the progress line', () => {
  it('says what the agent does now, the step and the minutes', async () => {
    await mount(bridgeFor(liveItems(minutesAgo(6))));
    expect(line()?.textContent).toBe('Edit bridge/http.rs · step 2 · 6 min');
    expect(line()?.getAttribute('role')).toBe('status');
  });

  it('counts the minutes on while the chat stays open', async () => {
    await mount(bridgeFor(liveItems(minutesAgo(6))));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(line()?.textContent).toContain('7 min');
  });

  it('shows only the time and the last action when the steps are not known (a chat read off the screen)', async () => {
    await mount(bridgeFor(liveItems(minutesAgo(3)), 'screen'));
    expect(line()?.textContent).toBe('Edit bridge/http.rs · 3 min');
  });

  it('works for a turn whose first message has no time: it counts from when the phone first saw it', async () => {
    await mount(bridgeFor(liveItems(null)));
    expect(line()?.textContent).toContain('under 1 min');
  });

  it('is gone when the agent is not working', async () => {
    await mount(bridgeFor(liveItems(minutesAgo(6))), false);
    expect(line()).toBeNull();
  });

  it('is gone when the last turn has ended', async () => {
    const ended: ChatItem[] = [...liveItems(minutesAgo(6)), { kind: 'turnEnd', id: '5:0', at: null, outcome: 'completed', durationMs: 1000 }];
    await mount(bridgeFor(ended));
    expect(line()).toBeNull();
  });

  it('follows the language', async () => {
    setLanguagePref('zh-TW', false);
    await mount(bridgeFor(liveItems(minutesAgo(6))));
    expect(line()?.textContent).toBe('Edit bridge/http.rs · 第 2 步 · 6 分鐘');
  });
});

describe('the drawer row', () => {
  it('shows the same line on the row of a working agent whose chat the phone reads', async () => {
    await mount(bridgeFor(liveItems(minutesAgo(6))));
    act(() => root.unmount());
    root = createRoot(host);
    // The chat view left the screen, which clears its note; read it again and keep it on screen next to the drawer.
    await act(async () => {
      root.render(
        <>
          <PhoneChatView bridge={bridgeFor(liveItems(minutesAgo(6)))} paneId={PANE_CODEX} canWatch canType working />
          <PhoneDrawer
            open
            onClose={() => undefined}
            panes={PHONE_PANES.filter((p) => p.agent_type !== 'powershell')}
            labels={new Map(PHONE_PANES.map((p) => [p.id, p.title ?? p.agent_type]))}
            agentName={(id) => id}
            attention={null}
            active=""
            bridgeReady
            onSelect={() => undefined}
            onSearch={() => undefined}
            onOverview={() => undefined}
            onSettings={() => undefined}
          />
        </>,
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    const row = [...host.querySelectorAll('.ph-drow')].find((el) => el.textContent?.includes('Billing tests'))!;
    expect(row.querySelector('.ph-drow-state')?.textContent).toBe('Edit bridge/http.rs · step 2 · 6 min');
    // The other rows keep their state words.
    const other = [...host.querySelectorAll('.ph-drow')].find((el) => el.textContent?.includes('Fix login redirect'))!;
    expect(other.querySelector('.ph-drow-state')?.textContent).not.toContain('step');
  });
});
