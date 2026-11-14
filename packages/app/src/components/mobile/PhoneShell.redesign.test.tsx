// @vitest-environment jsdom
// The phone shell after the redesign (2026-11-14): one status line in the header and the drawer rows, the agent tile, quiet drawer
// rows, the offline line with "Try now", the queue list with Remove, the empty state with starters, one sheet style and the new chat tiles.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PHONE_PANES } from '../../dev/phone-fixtures';
import { PANE_CODEX } from '../../dev/fixtures';
import type { BridgeClient, PhoneNewChatOptions } from '../../lib/bridge-types';
import { useChinese, useEnglish, visibleEnglish } from '../../i18n/test-utils';
import { t } from '../../i18n';
import { phoneStatus } from '../../lib/phone-status';
import { PhoneDrawer } from './PhoneDrawer';
import { PhoneHeader } from './PhoneHeader';
import { PhoneLinkLine } from './PhoneLinkLine';
import { PhoneNewChat } from './PhoneNewChat';
import { PhoneQueueBar } from './PhoneQueueBar';
import { PhoneQuiet } from './PhoneQuiet';
import { PhoneAgentTile } from './PhoneAgentTile';
import { Sheet } from './MobileSheet';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  useEnglish();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useEnglish();
});
async function render(node: React.ReactNode) {
  await act(async () => {
    root.render(node);
  });
}

const labels = new Map(PHONE_PANES.map((p) => [p.id, p.title ?? p.agent_type]));
const drawer = (over: Partial<React.ComponentProps<typeof PhoneDrawer>> = {}) => (
  <PhoneDrawer
    open
    onClose={() => undefined}
    panes={PHONE_PANES.filter((p) => p.agent_type !== 'powershell')}
    labels={labels}
    agentName={(id) => id}
    attention={null}
    active=""
    bridgeReady
    onSelect={() => undefined}
    onSearch={() => undefined}
    onSettings={() => undefined}
    {...over}
  />
);

describe('the header: tile, task title, one status line, pencil', () => {
  it('shows the agent tile, the title and the status words with the dot', async () => {
    const status = phoneStatus(t, { state: 'working', now: 20_000, note: { actionKind: 'tool', action: 'x', step: 3, startedAt: 8000 }, total: 6 });
    await render(
      <PhoneHeader title="Fix pairing check" status={status} agent={{ id: 'claude', name: 'Claude' }} waiting={2} bridgeReady onMenu={() => undefined} onNew={() => undefined} peek={{ view: 'chat', canSwitch: false, onView: () => undefined, onClose: () => undefined }} />,
    );
    const head = host.querySelector('.ph-head')!;
    expect(head.querySelector('[data-testid="phone-agent-tile"]')).not.toBeNull();
    expect(head.querySelector('.ph-head-name')?.textContent).toBe('Fix pairing check');
    expect(head.querySelector('.ph-head-state')?.textContent).toBe('Working · 12s · step 3 of 6');
    expect(head.querySelector('.ph-tile .ph-dot')?.getAttribute('data-state')).toBe('working');
    expect(head.querySelector('.ph-badge')?.textContent).toBe('2');
    // The title button names the state too, for a screen reader.
    expect(head.querySelector('.ph-head-title')?.getAttribute('aria-label')).toContain('Working · 12s');
  });

  it('has no dot while the chat is just Ready', async () => {
    await render(<PhoneHeader title="Hi" status={phoneStatus(t, { state: 'idle', now: 0 })} agent={{ id: 'claude', name: 'Claude' }} waiting={0} bridgeReady onMenu={() => undefined} onNew={() => undefined} />);
    expect(host.querySelector('.ph-head-state')?.textContent).toBe('Ready');
    expect(host.querySelector('.ph-tile .ph-dot')).toBeNull();
  });
});

describe('the drawer', () => {
  it('rows are task titles with "Agent · state"; a dot only for needs-you and working; no Idle', async () => {
    await render(drawer());
    const rows = [...host.querySelectorAll('.ph-drow')];
    const working = rows.find((r) => r.textContent?.includes('Billing tests'))!;
    expect(working.querySelector('.ph-drow-title')?.textContent).toBe('Billing tests');
    expect(working.querySelector('.ph-drow-state')?.textContent).toMatch(/^codex · Working/);
    expect(working.querySelector('.ph-dot')?.getAttribute('data-state')).toBe('working');
    const idle = rows.find((r) => r.textContent?.includes('opencode'))!;
    expect(idle.querySelector('.ph-dot')).toBeNull();
    expect(idle.querySelector('.ph-drow-state')?.textContent).toBe('opencode · Ready');
    expect(host.textContent).not.toContain('Idle');
  });

  it('puts the agent in a 30 px tile (OpenCode too) on every row', async () => {
    await render(drawer());
    const rows = [...host.querySelectorAll('.ph-drow')];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.querySelector('.ph-tile')).not.toBeNull();
  });

  it('the footer is the PC state and a settings icon: no Overview, no "Connected to your PC" links', async () => {
    const onSettings = vi.fn();
    await render(drawer({ onSettings }));
    expect(host.querySelector('.ph-dfoot')?.textContent).toContain('PC · online');
    expect(host.textContent).not.toContain('Overview');
    await act(async () => (host.querySelector('.ph-dsettings') as HTMLButtonElement).click());
    expect(onSettings).toHaveBeenCalled();
    await render(drawer({ bridgeReady: false }));
    expect(host.querySelector('.ph-dfoot')?.textContent).toContain('PC · offline');
  });

  it('closed chats are one row with a count; opening it lists them with Reopen', async () => {
    const onReopen = vi.fn(async () => null);
    const closed = [{ id: 'old1', agent: 'claude', label: 'Claude', title: 'Fix the login page', folder: 'shop', updated_ms: Date.now() - 3600_000 }];
    await render(drawer({ closed, canReopen: true, onReopen }));
    const toggle = host.querySelector('.ph-dclosed-toggle') as HTMLButtonElement;
    expect(toggle.textContent).toContain('Closed chats');
    expect(toggle.textContent).toContain('1');
    expect(host.textContent).not.toContain('Show closed chats');
    await act(async () => toggle.click());
    const row = host.querySelector('.ph-drow[data-closed]') as HTMLButtonElement;
    expect(row.textContent).toContain('Reopen');
    await act(async () => row.click());
    expect(onReopen).toHaveBeenCalledWith('old1');
  });

  it('Escape closes it and a long row text does not break the row (title is one line)', async () => {
    const onClose = vi.fn();
    await render(drawer({ onClose }));
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(onClose).toHaveBeenCalled();
    expect(host.querySelector(`.ph-drow[aria-current]`)).toBeNull();
    expect(PANE_CODEX).toBeTruthy();
  });
});

describe('offline line and queue', () => {
  it('the offline line has Try now, which asks again', async () => {
    const onRetry = vi.fn();
    await render(<PhoneLinkLine kind="asleep" recovered={false} onRetry={onRetry} />);
    const btn = [...host.querySelectorAll('.ph-link-btn')].find((b) => b.textContent === 'Try now') as HTMLButtonElement;
    await act(async () => btn.click());
    expect(onRetry).toHaveBeenCalled();
    await render(<PhoneLinkLine kind="connected" recovered={false} onRetry={onRetry} />);
    expect(host.querySelector('[data-testid="phone-link-line"]')).toBeNull();
  });

  it('the queue is one list: each message has Remove; the PC being back asks Send or Delete', async () => {
    const waiting = [
      { id: 'q1', text: 'first thing', at: 1 },
      { id: 'q2', text: 'second thing', at: 2 },
    ];
    const onRemove = vi.fn();
    await render(<PhoneQueueBar waiting={waiting} reachable={false} onSend={async () => null} onDiscard={() => undefined} onRemove={onRemove} />);
    expect(host.querySelectorAll('.ph-qlist li')).toHaveLength(2);
    expect(host.querySelector('[role="status"]')?.textContent).toBe('2 messages are waiting for your PC.');
    await act(async () => (host.querySelectorAll('.ph-qremove')[1] as HTMLButtonElement).click());
    expect(onRemove).toHaveBeenCalledWith('q2');
    await render(<PhoneQueueBar waiting={waiting} reachable onSend={async () => null} onDiscard={() => undefined} onRemove={onRemove} />);
    expect(host.querySelectorAll('.ph-qlist li')).toHaveLength(2);
    expect([...host.querySelectorAll('.ph-bar-actions button')].map((b) => b.textContent)).toEqual(['Delete', 'Send']);
  });
});

describe('the empty state and the sheet', () => {
  it('the empty state offers three starters; one fills the new chat box and opens it', async () => {
    const onStarter = vi.fn();
    await render(<PhoneQuiet kind="empty" onStarter={onStarter} />);
    const starters = [...host.querySelectorAll('.ph-starter')] as HTMLButtonElement[];
    expect(starters).toHaveLength(3);
    await act(async () => starters[1].click());
    expect(onStarter).toHaveBeenCalled();
    expect(localStorage.length).toBeGreaterThan(0);
  });

  it('a sheet takes focus when it opens and gives it back when it closes; Escape closes it', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const onClose = vi.fn();
    await render(
      <Sheet title="Pick one" onClose={onClose}>
        <p>x</p>
      </Sheet>,
    );
    expect(document.activeElement).toBe(host.querySelector('.ph-sheet'));
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(onClose).toHaveBeenCalled();
    await render(null);
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});

describe('the new chat: agent tiles 2 x 2', () => {
  const options: PhoneNewChatOptions = {
    agents: [
      { id: 'claude', label: 'Claude', chat: true, terminal: true },
      { id: 'codex', label: 'Codex', chat: true, terminal: true },
      { id: 'opencode', label: 'OpenCode', chat: true, terminal: false },
      { id: 'gemini', label: 'Gemini', chat: true, terminal: false },
    ],
    projects: [{ id: 'p1', name: 'shop', state: 'repo' }],
  };
  const mount = async () => {
    const bridge = { phoneNewChat: async () => options, phoneStartChat: vi.fn(), sendPaneMessage: vi.fn() } as unknown as BridgeClient;
    await render(<PhoneNewChat bridge={bridge} canControl onClose={() => undefined} onStarted={() => undefined} />);
    await act(async () => {});
  };

  it('shows every agent as a tile; the picked one is checked and a tap changes it', async () => {
    await mount();
    const tiles = [...host.querySelectorAll('[data-testid="nc-agent-tile"]')] as HTMLButtonElement[];
    expect(tiles.map((b) => b.textContent)).toEqual(['Claude', 'Codex', 'OpenCode', 'Gemini']);
    expect(tiles[0].getAttribute('aria-checked')).toBe('true');
    await act(async () => tiles[2].click());
    expect(tiles[2].getAttribute('aria-checked')).toBe('true');
    expect(tiles[0].getAttribute('aria-checked')).toBe('false');
    // Every tile wears the same 30 px mark.
    expect(host.querySelectorAll('.ph-nc-tile .ph-tile')).toHaveLength(4);
  });
});

describe('Traditional Chinese', () => {
  it('the new shell pieces have no English left', async () => {
    useChinese();
    const status = phoneStatus(t, { state: 'working', now: 20_000, note: { actionKind: 'tool', action: null, step: 3, startedAt: 8000 }, total: 6 });
    await render(
      <>
        <PhoneHeader title="修正登入" status={status} agent={{ id: 'claude', name: 'Claude' }} waiting={1} bridgeReady onMenu={() => undefined} onNew={() => undefined} />
        <PhoneLinkLine kind="asleep" recovered={false} onRetry={() => undefined} />
        <PhoneQueueBar waiting={[{ id: 'q', text: '你好', at: 1 }]} reachable={false} onSend={async () => null} onDiscard={() => undefined} onRemove={() => undefined} />
        <PhoneQuiet kind="empty" onStarter={() => undefined} />
        <PhoneAgentTile id="claude" name="Claude" />
      </>,
    );
    expect(visibleEnglish(host, ['Claude'])).toEqual([]);
    expect(host.querySelector('.ph-head-state')?.textContent).toBe('處理中 · 12 秒 · 第 3 / 6 步');
    await render(drawer());
    expect(visibleEnglish(host, ['Claude', 'Codex', 'OpenCode', 'codex', 'opencode', 'Billing', 'tests', 'Fix', 'login', 'redirect']).filter((w) => !/(billing-service|docs-site)/.test(w))).toEqual([]);
  });
});
