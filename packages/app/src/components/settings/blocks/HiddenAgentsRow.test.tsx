// @vitest-environment jsdom
// Settings > Agents > "Agents in the New agent menu": one row with Edit. Edit opens the same editor as the menu, a
// tick saves the hidden agent for the menu, and Done closes the editor.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LS_HIDDEN_AGENTS } from '../../../lib/hiddenAgents';
import { HiddenAgentsRow } from './HiddenAgentsRow';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  localStorage.clear();
});

const settle = async () => {
  for (let i = 0; i < 4; i += 1) await act(async () => {});
};
const buttonNamed = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label);
const box = (label: string) => host.querySelector<HTMLInputElement>(`input[aria-label="Show ${label} in the New agent menu"]`);

describe('Settings: Agents in the New agent menu', () => {
  it('shows one row with Edit, and Edit opens the editor with a tick for each agent', async () => {
    await act(async () => root.render(<HiddenAgentsRow />));
    await settle();
    expect(host.textContent).toContain('Agents in the New agent menu');
    expect(host.querySelector('[data-testid="hidden-agents-editor"]')).toBeNull();
    await act(async () => buttonNamed('Edit')!.click());
    await settle();
    expect(host.querySelector('[data-testid="hidden-agents-editor"]')).toBeTruthy();
    expect(box('Claude')!.checked).toBe(true);
  });

  it('a tick hides the agent and is saved; Done closes the editor', async () => {
    await act(async () => root.render(<HiddenAgentsRow />));
    await settle();
    await act(async () => buttonNamed('Edit')!.click());
    await settle();
    await act(async () => box('Claude')!.click());
    await settle();
    expect(box('Claude')!.checked).toBe(false);
    expect(JSON.parse(localStorage.getItem(LS_HIDDEN_AGENTS) ?? '[]')).toEqual(['claude']);
    await act(async () => buttonNamed('Done')!.click());
    await settle();
    expect(host.querySelector('[data-testid="hidden-agents-editor"]')).toBeNull();
  });
});
