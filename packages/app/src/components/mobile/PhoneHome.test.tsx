// @vitest-environment jsdom
// The phone's Inbox part (Done today, Team activity) rendered through the real Agents screen, and the drawer's "Ready"
// standby helpers rendered through the real drawer. Both are read-only and optional: an old PC shows nothing.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneInfo } from '@potato-workspace/shared';
import type { BridgeClient } from '../../lib/bridge';
import type { AttentionSnapshot } from '../../lib/attention';
import { ITEM_LOW } from '../../dev/attention-fixtures';
import { PHONE_PANES } from '../../dev/phone-fixtures';
import { PHONE_HELPERS, phoneDoneReply } from '../../dev/phone-home-fixtures';
import { phoneTeamReply } from '../../dev/phone-team-fixtures';
import { useChinese, useEnglish } from '../../i18n/test-utils';
import { AgentsOverview } from './AgentsOverview';
import { resetDigestCardForTests } from './DigestCard';
import { PhoneDrawer } from './PhoneDrawer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  useEnglish();
  resetDigestCardForTests();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useEnglish();
});

const panes = PHONE_PANES as unknown as PaneInfo[];
const labels = new Map(PHONE_PANES.map((p) => [p.id, p.title ?? p.agent_type]));

function bridgeWith(extra: Record<string, unknown>) {
  return { readBuffer: async () => 'line', digest: async () => ({ empty: true }), listQuestions: async () => [], ...extra } as unknown as BridgeClient;
}

async function overview(bridge: BridgeClient, onOpen: (id: string) => void = () => undefined) {
  await act(async () => {
    root.render(<AgentsOverview bridge={bridge} bridgeReady panes={panes} labels={labels} onOpen={onOpen} onNew={() => undefined} />);
  });
  for (let i = 0; i < 4; i++) await act(async () => {});
}

describe('phone home: place line, setup chip and Needs you', () => {
  const snapshot = (items: AttentionSnapshot['items']): AttentionSnapshot => ({
    v: 1,
    rev: 3,
    counts: { blocking: items.length, ready: 0 },
    items,
    device: { can_answer: true, can_type: true, can_control: true },
  });

  const home = async (bridge: BridgeClient, attention: AttentionSnapshot, setup: { done: number; onOpen: () => void }) => {
    await act(async () => {
      root.render(
        <AgentsOverview
          bridge={bridge}
          bridgeReady
          panes={panes}
          labels={labels}
          onOpen={() => undefined}
          onNew={() => undefined}
          questionsRevision={1}
          attention={attention}
          setup={{ done: setup.done, total: 3, onOpen: setup.onOpen }}
        />,
      );
    });
    for (let i = 0; i < 4; i++) await act(async () => {});
  };

  it('puts Needs you first: the waiting ask, its answer buttons, and one small setup chip', async () => {
    const answerAttention = vi.fn(async () => ({ outcome: 'answered' as const, choice_label: 'Allow once', at_ms: Date.now() }));
    const onOpenSetup = vi.fn();
    const attention = snapshot([ITEM_LOW]);
    await home(bridgeWith({ answerAttention }), attention, { done: 2, onOpen: onOpenSetup });

    // The PC this phone is connected to, as plain text.
    expect(host.querySelector('[data-testid="phone-place"]')?.textContent).toBe('Main PC');

    // Needs you comes before the other lists, with the waiting ask and its big buttons.
    const needs = host.querySelector('[data-testid="phone-needs-you"]')!;
    expect(needs.querySelector('h2')?.textContent).toBe('Needs you');
    expect(needs.textContent).toContain('Run tests');
    const choices = Array.from(needs.querySelectorAll('[data-choice]')).map((b) => b.textContent);
    expect(choices).toEqual(['Allow once', 'Deny']);
    expect(needs.compareDocumentPosition(host.querySelector('.ph-group')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // The answer goes through the same path the phone already uses.
    await act(async () => (needs.querySelector('[data-choice="allow_once"]') as HTMLButtonElement).click());
    expect(answerAttention).toHaveBeenCalledWith('a7Kp2xQ9', expect.objectContaining({ choice: 'allow_once' }), expect.anything());

    // Setup is one chip that opens the existing steps, not a whole screen.
    const chip = host.querySelector('[data-testid="phone-setup-chip"]') as HTMLButtonElement;
    expect(chip.textContent).toBe('Setup 2 of 3 done');
    await act(async () => chip.click());
    expect(onOpenSetup).toHaveBeenCalledTimes(1);
  });

  it('says nothing needs you, and hides the setup chip once all three steps are done', async () => {
    await home(bridgeWith({}), snapshot([]), { done: 3, onOpen: () => undefined });
    expect(host.querySelector('[data-testid="phone-needs-you"]')?.textContent).toContain('Nothing needs you right now.');
    expect(host.querySelector('[data-testid="phone-setup-chip"]')).toBeNull();
    expect(host.querySelector('[data-testid="phone-place"]')?.textContent).toBe('Main PC');
  });
});

describe('phone Inbox part on the Agents screen', () => {
  it('lists what finished today, newest first, with the numbers, and a row opens its chat', async () => {
    const phoneDone = vi.fn(async () => phoneDoneReply());
    const open = vi.fn();
    await overview(bridgeWith({ phoneDone, teamCards: async () => phoneTeamReply() }), open);
    const section = host.querySelector('[data-testid="phone-done-today"]')!;
    expect(section.querySelector('h2')?.textContent).toContain('Done today');
    const rows = Array.from(section.querySelectorAll('[data-done-row]'));
    expect(rows.map((r) => r.getAttribute('data-done-row'))).toEqual([PHONE_PANES[0].id, PHONE_PANES[1].id, PHONE_PANES[2].id]);
    expect(rows[0].textContent).toContain('12 files');
    expect(rows[0].textContent).toContain('+1,204');
    expect(rows[0].textContent).toContain('2/2 passed');
    expect(rows[1].textContent).toContain('Answered a question · no changes');
    // The call carries local midnight, not "now".
    const since = (phoneDone.mock.calls[0] as unknown as [number])[0];
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    expect(since).toBe(midnight.getTime());
    await act(async () => {
      (rows[1].querySelector('button') as HTMLButtonElement).click();
    });
    expect(open).toHaveBeenCalledWith(PHONE_PANES[1].id);
  });

  it('shows at most three team events as plain text and no action buttons', async () => {
    await overview(bridgeWith({ phoneDone: async () => phoneDoneReply(), teamCards: async () => phoneTeamReply() }));
    const section = host.querySelector('[data-testid="phone-team-activity"]')!;
    expect(section.querySelector('h2')?.textContent).toContain('Team activity');
    const rows = section.querySelectorAll('[data-team-activity]');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(3);
    expect(section.querySelector('button')).toBeNull();
  });

  it('says so when nothing finished yet, and shows nothing at all on a PC without the routes', async () => {
    await overview(bridgeWith({ phoneDone: async () => ({ now: 1, since: 0, rows: [] }) }));
    expect(host.querySelector('[data-testid="phone-done-today"]')?.textContent).toContain('Nothing finished yet today.');
    expect(host.querySelector('[data-testid="phone-team-activity"]')).toBeNull();
    await act(async () => root.render(<div />));
    await overview(bridgeWith({}));
    expect(host.querySelector('[data-testid="phone-inbox-home"]')).toBeNull();
  });

  it('shows nothing when the PC refuses the phone (no watch right)', async () => {
    const refused = async () => {
      throw new Error('GET /phone/done -> 403: {"error":"not_allowed"}');
    };
    await overview(bridgeWith({ phoneDone: refused, teamCards: refused }));
    expect(host.querySelector('[data-testid="phone-inbox-home"]')).toBeNull();
  });

  it('cuts the list at six with "Show all"', async () => {
    const base = phoneDoneReply();
    const rows = Array.from({ length: 9 }, (_, n) => ({ ...base.rows[1], paneId: `x${n}`, endedAtMs: base.now - n * 60_000 }));
    await overview(bridgeWith({ phoneDone: async () => ({ ...base, rows }) }));
    expect(host.querySelectorAll('[data-done-row]').length).toBe(6);
    const more = host.querySelector('.ph-ibx-more') as HTMLButtonElement;
    expect(more.textContent).toBe('Show all 9');
    await act(async () => more.click());
    expect(host.querySelectorAll('[data-done-row]').length).toBe(9);
  });

  it('speaks Chinese', async () => {
    useChinese();
    await overview(bridgeWith({ phoneDone: async () => phoneDoneReply() }));
    expect(host.querySelector('[data-testid="phone-done-today"] h2')?.textContent).toContain('今天完成');
  });
});

describe('phone drawer: Ready standby helpers', () => {
  const drawer = (bridge?: unknown) => (
    <PhoneDrawer
      open
      onClose={() => undefined}
      panes={panes.filter((p) => p.agent_type !== 'powershell')}
      labels={labels}
      agentName={(id) => id}
      attention={null}
      active=""
      bridgeReady
      onSelect={() => undefined}
      onSearch={() => undefined}
      onSettings={() => undefined}
      bridge={bridge as BridgeClient | undefined}
    />
  );
  const render = async (node: React.ReactNode) => {
    await act(async () => {
      root.render(node);
    });
    for (let i = 0; i < 3; i++) await act(async () => {});
  };

  it('lists only the helpers that are ready, with the folder name and no path', async () => {
    await render(drawer({ phoneHelpers: async () => PHONE_HELPERS }));
    const section = host.querySelector('[data-testid="drawer-ready"]')!;
    expect(section.querySelector('h2')?.textContent).toBe('Ready');
    const names = Array.from(section.querySelectorAll('.ph-drow-title')).map((n) => n.textContent);
    expect(names).toEqual(['Reviewer', 'Docs helper']);
    expect(section.textContent).toContain('billing-service');
    expect(section.textContent).not.toMatch(/[\\/]/);
  });

  it('shows Done today and Team activity in the drawer and a row opens its chat', async () => {
    const onSelect = vi.fn();
    await render(
      <PhoneDrawer
        open
        onClose={() => undefined}
        panes={panes.filter((p) => p.agent_type !== 'powershell')}
        labels={labels}
        agentName={(id) => id}
        attention={null}
        active=""
        bridgeReady
        onSelect={onSelect}
        onSearch={() => undefined}
        onSettings={() => undefined}
        bridge={{ phoneDone: async () => phoneDoneReply(), teamCards: async () => phoneTeamReply(), phoneHelpers: async () => PHONE_HELPERS } as unknown as BridgeClient}
      />,
    );
    const done = host.querySelector('[data-testid="phone-done-today"]')!;
    expect(done.querySelectorAll('[data-done-row]').length).toBe(3);
    expect(host.querySelector('[data-testid="phone-team-activity"]')).not.toBeNull();
    await act(async () => (done.querySelectorAll('[data-done-row] button')[0] as HTMLButtonElement).click());
    expect(onSelect).toHaveBeenCalledWith(PHONE_PANES[0].id);
  });

  it('shows the tasks the person put in the sidebar on the PC, under their agent or on their own, read only', async () => {
    const row = (taskId: string, kind: 'minion' | 'command', owner: string, under: string | null, name: string, status: string) => ({ taskId, kind, owner, under, name, status });
    await render(
      drawer({
        phoneTasks: async () => ({ rows: [row('minion:m1', 'minion', PHONE_PANES[0].id, PHONE_PANES[0].id, 'Reviewer', 'running'), row('job:x:7:1', 'command', PHONE_PANES[0].id, null, 'Dev server', 'running')] }),
      }),
    );
    const section = host.querySelector('[data-testid="drawer-tasks"]')!;
    expect(section.querySelector('h2')?.textContent).toBe('Tasks');
    const rows = Array.from(section.querySelectorAll('[data-task-id]'));
    expect(rows.map((r) => r.getAttribute('data-task-id'))).toEqual(['minion:m1', 'job:x:7:1']);
    expect(rows[0].textContent).toContain('minion');
    expect(rows[1].textContent).toContain('command');
    // The one on its own names its agent quietly; nothing here can be dragged or stopped.
    expect(rows[1].textContent).toContain('↳');
    expect(section.querySelector('button')).toBeNull();
  });

  it('shows no Tasks part when there are none, the PC is old, or the PC refuses', async () => {
    await render(drawer({ phoneTasks: async () => ({ rows: [] }) }));
    expect(host.querySelector('[data-testid="drawer-tasks"]')).toBeNull();
    await render(drawer({}));
    expect(host.querySelector('[data-testid="drawer-tasks"]')).toBeNull();
    await render(
      drawer({
        phoneTasks: async () => {
          throw new Error('403');
        },
      }),
    );
    expect(host.querySelector('[data-testid="drawer-tasks"]')).toBeNull();
  });

  it('shows no Ready part when none is ready, the PC is old, or the PC refuses', async () => {
    await render(drawer({ phoneHelpers: async () => ({ max: 4, helpers: PHONE_HELPERS.helpers.slice(2) }) }));
    expect(host.querySelector('[data-testid="drawer-ready"]')).toBeNull();
    await render(drawer({}));
    expect(host.querySelector('[data-testid="drawer-ready"]')).toBeNull();
    await render(
      drawer({
        phoneHelpers: async () => {
          throw new Error('403');
        },
      }),
    );
    expect(host.querySelector('[data-testid="drawer-ready"]')).toBeNull();
  });
});
