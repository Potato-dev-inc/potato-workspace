// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixProblem, reportProblem, resetProblems } from '../../../lib/problems';
import { ProblemsChip } from './ProblemsChip';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
const actions = { openChat: vi.fn(), signIn: vi.fn(), tryAgain: vi.fn() };
beforeEach(() => {
  window.localStorage.clear();
  resetProblems();
  Object.values(actions).forEach((a) => a.mockClear());
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const chip = () => host.querySelector<HTMLButtonElement>('[data-testid="problems-chip"]');
const sheet = () => host.querySelector('[data-testid="problems-sheet"]');
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === text);
const mount = () => act(async () => root.render(<ProblemsChip actions={actions} />));

describe('ProblemsChip', () => {
  it('shows nothing when there is no problem', async () => {
    await mount();
    expect(chip()).toBeNull();
  });

  it('says how many, singular and plural, and counts only open ones', async () => {
    await mount();
    await act(async () => reportProblem({ id: 'error:p1', what: 'Claude stopped because of an error.', agent: 'Claude', agentId: 'claude', paneId: 'p1', way: 'open_chat' }));
    expect(chip()!.textContent).toBe('1 problem');
    await act(async () => reportProblem({ id: 'signin:codex:', what: "Codex's sign-in ended.", agent: 'Codex', agentId: 'codex', paneId: null, way: 'sign_in' }));
    expect(chip()!.textContent).toBe('2 problems');
    await act(async () => fixProblem('signin:codex:'));
    expect(chip()!.textContent).toBe('1 problem');
  });

  it('opens a sheet, newest first, in plain words with the agent and whether it is fixed', async () => {
    reportProblem({ id: 'a', what: 'Older thing.', agent: 'Claude', agentId: 'claude', paneId: 'p1', way: 'open_chat', at: 1000 });
    reportProblem({ id: 'b', what: 'Newer thing.', agent: 'Codex', agentId: 'codex', paneId: null, way: 'sign_in', at: 2000 });
    await mount();
    await act(async () => chip()!.click());
    expect(sheet()!.getAttribute('role')).toBe('dialog');
    const rows = [...host.querySelectorAll('.pb-row')];
    expect(rows.map((r) => r.querySelector('.pb-what')!.textContent)).toEqual(['Newer thing.', 'Older thing.']);
    expect(rows[0].querySelector('.pb-meta')!.textContent).toContain('Codex');
    expect(rows[0].querySelector('.pb-meta')!.textContent).toContain('Not fixed');
  });

  it('each row has its one way out: Open the chat, Sign in, Copy details', async () => {
    reportProblem({ id: 'a', what: 'A.', agent: 'Claude', agentId: 'claude', paneId: 'p1', way: 'open_chat', at: 1 });
    reportProblem({ id: 'b', what: 'B.', agent: 'Codex', agentId: 'codex', paneId: null, way: 'sign_in', at: 2 });
    await mount();
    await act(async () => chip()!.click());
    await act(async () => button('Sign in')!.click());
    expect(actions.signIn).toHaveBeenCalledWith('codex');
    expect(sheet()).toBeNull(); // acting closes the sheet
    await act(async () => chip()!.click());
    await act(async () => button('Open the chat')!.click());
    expect(actions.openChat).toHaveBeenCalledWith('p1');
    await act(async () => chip()!.click());
    expect(host.querySelectorAll('button.pb-link').length).toBeGreaterThanOrEqual(2); // Copy details on every open row
  });

  it('a fixed row fades and has no buttons; Clear removes it; Escape closes the sheet and returns focus', async () => {
    reportProblem({ id: 'a', what: 'A.', agent: 'Claude', agentId: 'claude', paneId: 'p1', way: 'open_chat' });
    reportProblem({ id: 'b', what: 'B.', agent: 'Codex', agentId: 'codex', paneId: 'p2', way: 'open_chat' });
    await mount();
    await act(async () => chip()!.click());
    await act(async () => fixProblem('a'));
    const fixed = host.querySelector('.pb-row.is-fixed')!;
    expect(fixed.textContent).toContain('Fixed');
    expect(fixed.querySelector('button')).toBeNull();
    await act(async () => button('Clear')!.click());
    expect(host.querySelectorAll('.pb-row')).toHaveLength(1);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(sheet()).toBeNull();
  });

  it('the chip is a button with a popup, for the keyboard and for screen readers', async () => {
    reportProblem({ id: 'a', what: 'A.', agent: null, agentId: null, paneId: null, way: 'copy' });
    await mount();
    expect(chip()!.tagName).toBe('BUTTON');
    expect(chip()!.getAttribute('aria-haspopup')).toBe('dialog');
    await act(async () => chip()!.click());
    expect(chip()!.getAttribute('aria-expanded')).toBe('true');
  });
});
