// @vitest-environment jsdom
// The project budget card and the right-size line, in the real chat view (SessionChatPanel), so they cannot ship unseen.
//   Project budget reached · Raise · Wait until tomorrow    (the project used up its day; Raise gives more room)
//   This looked small. Try Haiku next time? · Switch · Don't suggest
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => undefined }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import type { ChatItem } from '../../lib/sessionChatModel';
import type { ProjectBudgetStatus, RightSizeSuggestion } from '../../lib/tauri';
import { SessionChatPanel } from './SessionChatPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let items: ChatItem[];
let status: ProjectBudgetStatus | null;
let suggestion: RightSizeSuggestion | null;
const calls: string[] = [];

const flush = () => act(async () => { await new Promise((r) => setImmediate(r)); });
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.startsWith(text));

const reached = (turns = 3): ProjectBudgetStatus => ({
  limits: { turnsPerDay: turns, minutesPerDay: null, planPercent: null },
  usedTurns: turns,
  usedMinutes: 2,
  planPercent: null,
  reached: 'turns',
});

function finishedTurn(): ChatItem[] {
  return [
    { kind: 'user', id: 'u1', at: null, text: 'rename x' },
    { kind: 'assistant', id: 'a1', at: null, text: 'done', model: null, finalAnswer: true },
    { kind: 'notice', id: 'n:ending:done:1', at: null, noticeKind: 'ending:done', text: 'Done' },
    { kind: 'turnEnd', id: 'end:1', at: null, outcome: 'completed', durationMs: 1000 },
  ] as ChatItem[];
}

beforeEach(() => {
  (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
  invoke.mockReset();
  calls.length = 0;
  items = finishedTurn();
  status = null;
  suggestion = null;
  invoke.mockImplementation(async (cmd: string) => {
    calls.push(cmd);
    if (cmd === 'session_chat_open') return { available: true, reason: null, items, source: 'acp' };
    if (cmd === 'pane_messages_list') return [];
    if (cmd === 'keep_going_lineage') return { from: null, to: null };
    if (cmd === 'project_budget_status') return status;
    if (cmd === 'project_budget_raise') {
      status = null;
      return null;
    }
    if (cmd === 'right_size_pending') return suggestion;
    if (cmd === 'right_size_switch') {
      suggestion = null;
      return { model: 'Haiku' };
    }
    if (cmd === 'patch_settings') return {};
    return undefined;
  });
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

async function mount(running = false) {
  await act(async () => {
    root.render(<SessionChatPanel paneId="p1" reply={{ blockedReason: null, running }} />);
  });
  await flush();
  await flush();
}

describe('project budget card in the chat', () => {
  it('shows nothing while the project is under its limits', async () => {
    await mount();
    expect(host.querySelector('[data-testid="project-budget-card"]')).toBeNull();
  });

  it('says the project budget is reached, in plain words, with Raise and Wait until tomorrow', async () => {
    status = reached(3);
    await mount();
    const card = host.querySelector('[data-testid="project-budget-card"]');
    expect(card?.textContent).toContain('Project budget reached');
    expect(card?.textContent).toContain('3 turns for today');
    expect(card?.textContent).toContain('A turn that is running will finish');
    expect(button('Raise')).toBeTruthy();
    expect(button('Wait until tomorrow')).toBeTruthy();
  });

  it('Raise asks the app to give more room and the card goes away', async () => {
    status = reached();
    await mount();
    await act(async () => button('Raise')!.click());
    await flush();
    expect(calls).toContain('project_budget_raise');
    expect(host.querySelector('[data-testid="project-budget-card"]')).toBeNull();
  });

  it('Wait until tomorrow keeps the limit and says when new turns start again', async () => {
    status = reached();
    await mount();
    await act(async () => button('Wait until tomorrow')!.click());
    const card = host.querySelector('[data-testid="project-budget-card"]');
    expect(card?.textContent).toContain('start again tomorrow');
    expect(button('Raise')).toBeUndefined();
    expect(calls).not.toContain('project_budget_raise');
  });
});

describe('right-size line in the chat', () => {
  const small: RightSizeSuggestion = { kind: 'smaller', fromName: 'Opus', toValue: 'haiku', toName: 'Haiku' };

  it('shows nothing when the app has no suggestion', async () => {
    await mount();
    expect(host.querySelector('[data-testid="right-size-line"]')).toBeNull();
  });

  it('suggests the cheaper model after a small task, with Switch and Don\'t suggest', async () => {
    suggestion = small;
    await mount();
    const line = host.querySelector('[data-testid="right-size-line"]');
    expect(line?.textContent).toContain('This looked small. Try Haiku next time?');
    expect(button('Switch')).toBeTruthy();
    expect(button("Don't suggest")).toBeTruthy();
  });

  it('names the stronger model when the cheap one had a hard time', async () => {
    suggestion = { kind: 'stronger', fromName: 'Haiku', toValue: 'sonnet', toName: 'Sonnet' };
    await mount();
    expect(host.querySelector('[data-testid="right-size-line"]')?.textContent).toContain('Haiku had a hard time with this. Try Sonnet next time?');
  });

  it('is not shown while a turn is running', async () => {
    suggestion = small;
    await mount(true);
    expect(host.querySelector('[data-testid="right-size-line"]')).toBeNull();
  });

  it('Switch changes the model and says so', async () => {
    suggestion = small;
    await mount();
    await act(async () => button('Switch')!.click());
    await flush();
    expect(calls).toContain('right_size_switch');
    expect(host.querySelector('[data-testid="right-size-line"]')?.textContent).toContain('Now using Haiku.');
  });

  it("Don't suggest closes the line and turns the suggestions off", async () => {
    suggestion = small;
    await mount();
    await act(async () => button("Don't suggest")!.click());
    await flush();
    expect(calls).toContain('right_size_dismiss');
    expect(host.querySelector('[data-testid="right-size-line"]')).toBeNull();
  });
});
