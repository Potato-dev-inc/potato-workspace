// @vitest-environment jsdom
// The agent cards: the tool call card and its status states, the terminal output with Copy (and its fallback), the diff
// file card with Copy patch, the live step list with its timer and folded summary, the plan card and the code block header.
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanItem, ToolStep } from '../../lib/sessionChatModel';
import { ActivityLine } from './ActivityLine';
import { ChatMarkdown } from './ChatMarkdown';
import { PlanCard } from './PlanCard';
import { cardState, ToolRow } from './ToolRow';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const render = (node: ReactNode) => act(() => root.render(node));
const click = (el: Element | null) => act(() => (el as HTMLElement).click());
const settle = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

function step(id: string, name: string, over: Partial<ToolStep['call']> = {}, status: ToolStep['status'] = 'ok', output: string | null = ''): ToolStep {
  const call = { kind: 'toolCall' as const, id, at: null, callId: id, name, summary: `${name} target`, ...over };
  const result = output === null ? null : { kind: 'toolResult' as const, id: `r${id}`, at: null, callId: id, ok: status !== 'error', output };
  return { kind: 'tool', id, call, result, status };
}

function mockClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
}

describe('the tool call card', () => {
  it('maps status and liveness to pending, running, done and failed', () => {
    expect(cardState('running', true)).toBe('running');
    expect(cardState('running', false)).toBe('pending');
    expect(cardState('ok', false)).toBe('done');
    expect(cardState('error', true)).toBe('failed');
  });

  it.each([
    ['running', null, true, 'running', 'Running'],
    ['ok', 'x', true, 'done', 'Done'],
    ['error', 'boom', true, 'failed', 'Failed'],
    ['running', null, false, 'pending', 'Pending'],
  ] as const)('shows a %s call (output %s, live %s) as %s with the badge %s', (status, output, live, state, label) => {
    render(<ToolRow step={step('1', 'Bash', {}, status, output)} fromScreen={false} live={live} />);
    const badge = host.querySelector('.ck-agc-badge')!;
    expect(badge.getAttribute('data-state')).toBe(state);
    expect(badge.textContent).toBe(label);
    // Only a running badge shimmers and turns.
    expect(!!badge.querySelector('.ck-agc-shim')).toBe(state === 'running');
    expect(!!badge.querySelector('.ck-agc-spin')).toBe(state === 'running');
  });

  it('has an icon, a title, the mono summary and no badge when read off the screen', () => {
    render(<ToolRow step={step('1', 'Bash', { summary: 'npm test' })} fromScreen={true} />);
    expect(host.querySelector('.ck-agc-ico svg')).not.toBeNull();
    expect(host.querySelector('.ck-agc-name')?.textContent).toBe('Bash');
    expect(host.querySelector('.ck-agc-sub')?.textContent).toBe('npm test');
    expect(host.querySelector('.ck-agc-badge')).toBeNull();
  });

  it('opens and closes on a click of the header, showing Input and Output', () => {
    render(<ToolRow step={step('1', 'Bash', { input: { command: 'npm test' } }, 'ok', 'passed')} fromScreen={false} />);
    const head = host.querySelector<HTMLButtonElement>('.ck-chat-row > button')!;
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector('[data-testid="tool-output"]')).toBeNull();
    click(head);
    expect(head.getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelector('.ck-agc-code')?.textContent).toBe('npm test');
    expect(host.querySelector('[data-testid="tool-output"]')?.textContent).toBe('passed');
    click(head);
    expect(host.querySelector('[data-testid="tool-output"]')).toBeNull();
  });

  it('marks a failed command: a failed terminal and a stronger card', () => {
    render(<ToolRow step={step('1', 'Bash', { input: { command: 'npm test' } }, 'error', 'boom')} fromScreen={false} defaultOpen />);
    expect(host.querySelector('.ck-agc-card--failed')).not.toBeNull();
    expect(host.querySelector('.ck-agc-term')?.hasAttribute('data-failed')).toBe(true);
    expect(host.querySelector('.ck-agc-term-head')?.textContent).toContain('failed');
  });
});

describe('the terminal output', () => {
  const open = (output: string) => render(<ToolRow step={step('1', 'Bash', {}, 'ok', output)} fromScreen={false} defaultOpen />);
  const copyButton = () => host.querySelector<HTMLButtonElement>('.ck-agc-term-head .ck-agc-copy')!;

  it('copies the output as written and says Copied', async () => {
    const writeText = vi.fn(async () => undefined);
    mockClipboard(writeText);
    open('line 1\nline 2');
    expect(copyButton().textContent).toBe('Copy');
    click(copyButton());
    await settle();
    expect(writeText).toHaveBeenCalledWith('line 1\nline 2');
    expect(copyButton().textContent).toBe('Copied');
  });

  it('selects the text when the clipboard says no, and says Selected', async () => {
    mockClipboard(async () => {
      throw new Error('denied');
    });
    open('keep me');
    click(copyButton());
    await settle();
    expect(copyButton().textContent).toBe('Selected');
    expect(window.getSelection()?.toString()).toBe('keep me');
  });

  it('goes back to Copy after a moment', async () => {
    mockClipboard(async () => undefined);
    open('x');
    vi.useFakeTimers();
    click(copyButton());
    await settle();
    expect(copyButton().textContent).toBe('Copied');
    act(() => {
      vi.advanceTimersByTime(1600);
    });
    expect(copyButton().textContent).toBe('Copy');
  });

  it('has no Copy button while there is no output yet', () => {
    render(<ToolRow step={step('1', 'Bash', {}, 'running', null)} fromScreen={false} defaultOpen />);
    expect(host.querySelector('.ck-agc-term-head .ck-agc-copy')).toBeNull();
    expect(host.querySelector('[data-testid="tool-output"]')?.textContent).toBe('No output yet.');
  });
});

describe('the diff file card', () => {
  const edit = step('1', 'Edit', { writes: true, paths: ['src/app.ts'], input: { file_path: 'src/app.ts', old_string: 'a\nb', new_string: 'a\nB\nC' } });

  it('shows the file with its added and removed counts, no accept or reject', () => {
    render(<ToolRow step={edit} fromScreen={false} defaultOpen />);
    const card = host.querySelector('[data-testid="tool-diff"]')!;
    expect(card.querySelector('.ck-agc-diff-path')?.textContent).toBe('app.ts');
    expect([...card.querySelectorAll('.ck-agc-diff-stat')].map((n) => n.textContent)).toEqual(['+2', '−1']);
    expect(card.textContent).not.toMatch(/accept|reject/i);
  });

  it('copies the patch', async () => {
    const writeText = vi.fn(async () => undefined);
    mockClipboard(writeText);
    render(<ToolRow step={edit} fromScreen={false} defaultOpen />);
    const button = host.querySelector<HTMLButtonElement>('.ck-agc-diff-head .ck-agc-copy')!;
    expect(button.textContent).toBe('Copy patch');
    click(button);
    await settle();
    expect(writeText).toHaveBeenCalledWith('--- src/app.ts\n+++ src/app.ts\n a\n-b\n+B\n+C');
    expect(button.textContent).toBe('Copied');
  });
});

describe('the live step list', () => {
  const at = (sec: number) => new Date(Date.UTC(2026, 9, 28, 1, 0, sec)).toISOString();
  const live = [step('1', 'Read', { at: at(0), summary: 'src/a.ts' }, 'ok'), step('2', 'Bash', { at: at(2), summary: 'npm test' }, 'running', null)];

  it('lists the steps: a tick for the finished one, a turning ring and shimmer for the current one', () => {
    render(<ActivityLine steps={live} live fromScreen={false} verbose={false} />);
    const items = [...host.querySelectorAll('[data-testid="activity-steps"] li')];
    expect(items.map((li) => li.getAttribute('data-status'))).toEqual(['ok', 'running']);
    expect(items[0]!.querySelector('.ck-agc-check')).not.toBeNull();
    expect(items[1]!.querySelector('.ck-agc-spin')).not.toBeNull();
    expect(items[1]!.querySelector('.ck-agc-shim')?.textContent).toBe('Bash npm test');
    expect(host.querySelector('.ck-chat-activity')?.textContent).toBe('Working · Bash npm test');
  });

  it('counts the time from the first step when it has a time, and ticks each second', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(at(5)));
    render(<ActivityLine steps={live} live fromScreen={false} verbose={false} />);
    expect(host.querySelector('[data-testid="activity-elapsed"]')?.textContent).toBe('5s');
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(host.querySelector('[data-testid="activity-elapsed"]')?.textContent).toBe('8s');
  });

  it('counts from mount when no step has a time', () => {
    vi.useFakeTimers();
    render(<ActivityLine steps={[step('1', 'Bash', {}, 'running', null)]} live fromScreen={false} verbose={false} />);
    expect(host.querySelector('[data-testid="activity-elapsed"]')?.textContent).toBe('<1s');
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(host.querySelector('[data-testid="activity-elapsed"]')?.textContent).toBe('4s');
  });

  it('hides the list and timer when the turn is over, and folds to Done in 14s · 2 steps when opened', () => {
    const done = [
      { ...step('1', 'Read', { at: at(0) }, 'ok'), result: { kind: 'toolResult' as const, id: 'r1', at: at(5), callId: '1', ok: true, output: '' } },
      { ...step('2', 'Bash', { at: at(6) }, 'ok'), result: { kind: 'toolResult' as const, id: 'r2', at: at(14), callId: '2', ok: true, output: '' } },
    ];
    render(<ActivityLine steps={done} live={false} fromScreen={false} verbose={false} />);
    expect(host.querySelector('[data-testid="activity-steps"]')).toBeNull();
    expect(host.querySelector('[data-testid="activity-elapsed"]')).toBeNull();
    expect(host.querySelector('[data-testid="activity-done"]')).toBeNull();
    click(host.querySelector('.ck-chat-activity'));
    expect(host.querySelector('[data-testid="activity-done"]')?.textContent).toBe('Done in 14s · 2 steps');
  });

  it('says only "Done · 1 step" when the rows have no times', () => {
    render(<ActivityLine steps={[step('1', 'Read')]} live={false} fromScreen={false} verbose />);
    expect(host.querySelector('[data-testid="activity-done"]')?.textContent).toBe('Done · 1 step');
  });

  it('shows a call that never finished as pending once the turn is over', () => {
    render(<ActivityLine steps={[step('1', 'Bash', {}, 'running', null)]} live={false} fromScreen={false} verbose />);
    expect(host.querySelector('.ck-agc-badge')?.getAttribute('data-state')).toBe('pending');
  });
});

describe('the plan card', () => {
  const items: PlanItem[] = [
    { text: 'Read the code', status: 'completed' },
    { text: 'Write the fix', status: 'in_progress' },
    { text: 'Run the tests', status: 'pending' },
    { text: 'Ship it', status: 'pending' },
  ];

  it('says how many steps there are and how many are done', () => {
    render(<PlanCard items={items} />);
    expect(host.querySelector('.ck-agc-name')?.textContent).toBe('Plan · 4 steps');
    expect(host.querySelector('[data-testid="plan-progress"]')?.textContent).toBe('1 of 4');
  });

  it('marks each step: a tick, a turning ring, and hollow dots', () => {
    render(<PlanCard items={items} />);
    const rows = [...host.querySelectorAll('li')];
    expect(rows[0]!.querySelector('.ck-agc-check')).not.toBeNull();
    expect(rows[1]!.querySelector('.ck-agc-spin')).not.toBeNull();
    expect(rows[2]!.querySelector('.ck-agc-dot')).not.toBeNull();
    expect(rows.map((r) => r.getAttribute('data-status'))).toEqual(['completed', 'in_progress', 'pending', 'pending']);
  });

  it('folds and opens the list from the head', () => {
    render(<PlanCard items={items} />);
    const head = host.querySelector<HTMLButtonElement>('.ck-agc-plan-h button')!;
    expect(head.getAttribute('aria-expanded')).toBe('true');
    click(head);
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector('ol')).toBeNull();
    expect(host.querySelector('[data-testid="plan-progress"]')?.textContent).toBe('1 of 4');
    click(head);
    expect(host.querySelectorAll('li')).toHaveLength(4);
  });

  it('draws nothing for an empty list, and says "1 step" for one', () => {
    render(<PlanCard items={[]} />);
    expect(host.querySelector('[data-testid="chat-plan"]')).toBeNull();
    render(<PlanCard items={[{ text: 'Only', status: 'pending' }]} />);
    expect(host.querySelector('.ck-agc-name')?.textContent).toBe('Plan · 1 step');
  });
});

describe('the code block header', () => {
  it('shows the language and the Copy button in the header', () => {
    render(<ChatMarkdown text={'```ts\nconst a = 1;\n```'} />);
    const head = host.querySelector('.ck-agc-codehead')!;
    expect(head.querySelector('.ck-agc-codelang')?.textContent).toBe('ts');
    expect(head.querySelector('button.ck-chat-md-copy')?.textContent).toBe('Copy');
    expect(host.querySelector('pre')?.textContent).toBe('const a = 1;');
  });

  it('labels a block with no language as text', () => {
    render(<ChatMarkdown text={'```\nplain\n```'} />);
    expect(host.querySelector('.ck-agc-codelang')?.textContent).toBe('text');
  });
});
