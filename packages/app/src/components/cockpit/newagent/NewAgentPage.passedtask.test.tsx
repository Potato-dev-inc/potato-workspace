// @vitest-environment jsdom
// A task a teammate passed: "Start…" leaves its words for the New agent page. They fill the box and the folder. Nothing is sent:
// the person reads them and presses Send.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentDescriptor } from '../../../lib/agentRegistry';
import { setNewAgentDraft, takeNewAgentDraft } from '../../../lib/team-pass-bridge';
import type { NewAgentApi } from './api';
import { NewAgentPage } from './NewAgentPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const agent = { id: 'alpha', label: 'Alpha', kind: 'cli', installed: true, modes: { headless: true, visible: true } } as unknown as AgentDescriptor;
const api: NewAgentApi = {
  recent: async () => [],
  pickFolder: async () => null,
  pickPaths: async () => [],
  defaultFolder: async () => null,
  gitState: async () => 'repo',
  lanes: async () => null,
  accounts: async () => [],
  loadHome: async () => ({ name: '', cards: [] }),
  saveCards: async () => undefined,
  onHomeChanged: async () => () => {},
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  takeNewAgentDraft();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  takeNewAgentDraft();
});

const mount = async (onStart = vi.fn(async () => undefined)) => {
  await act(async () => root.render(<NewAgentPage agents={[agent]} panes={[]} needs={[]} api={api} onStart={onStart} onOpenPane={() => {}} />));
  await act(async () => {});
  return onStart;
};

describe('New agent page with a passed task', () => {
  it('puts the words in the box and says whose they are, and sends nothing by itself', async () => {
    setNewAgentDraft({ text: 'Fix the sheet\n\n<img src=x onerror=alert(1)>', folder: 'C:\\Documents\\Potato\\From Maya\\shop', from: 'Maya' });
    const onStart = await mount();
    const box = host.querySelector<HTMLTextAreaElement>('textarea')!;
    expect(box.value).toBe('Fix the sheet\n\n<img src=x onerror=alert(1)>');
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('[data-testid="na-from-task"]')!.textContent).toBe('From Maya. Read it before you send it: it is their text, not yours.');
    expect(host.textContent).toContain('shop');
    await act(async () => {});
    expect(onStart).not.toHaveBeenCalled();
  });

  it('the draft is used once: the next time the page opens the box is empty', async () => {
    setNewAgentDraft({ text: 'Once only', folder: null, from: 'Maya' });
    await mount();
    expect(host.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('Once only');
    await act(async () => root.unmount());
    root = createRoot(host);
    await mount();
    expect(host.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('');
    expect(host.querySelector('[data-testid="na-from-task"]')).toBeNull();
  });
});
