// @vitest-environment jsdom
// Settings > Agents as a person meets it: "Add an agent" and "Your agents" are open, every other group is a card that
// starts closed and opens on a click (and remembers it), in the same cards the Advanced page uses.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BASE_SETTINGS, settle } from './settings/test-utils';
import { SettingsPanel, type SettingsApi } from './SettingsPanel';

vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

let host: HTMLDivElement;
let root: Root;
const api: SettingsApi = {
  load: async () => ({ ...BASE_SETTINGS }),
  patch: async () => ({ ...BASE_SETTINGS }),
  findBridgeUrl: async () => null,
  subscribe: () => () => {},
};

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* none */
  }
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const mount = async () => {
  await act(async () => root.render(<SettingsPanel open inline api={api} initialTab="agents" />));
  await settle(6);
};
const cards = () => [...host.querySelectorAll<HTMLElement>('.st-main .st-closed-group')];

describe('Settings > Agents cards', () => {
  it('the agent list stays open and every other group is a closed card with its count', async () => {
    await mount();
    expect(host.querySelector('.st-main [data-row="add-agent"]')).not.toBeNull();
    expect(host.querySelector('.st-main [data-row="agent-list"]')).not.toBeNull();
    const all = cards();
    expect(all.length).toBeGreaterThanOrEqual(6);
    for (const card of all) {
      expect(card.getAttribute('data-open')).toBe('false');
      expect(card.querySelector('[data-row]')).toBeNull();
      expect(card.querySelector('.st-adv-toggle')?.getAttribute('aria-expanded')).toBe('false');
    }
    const names = all.map((c) => c.getAttribute('data-group'));
    expect(names).not.toContain('Your agents');
    expect(names).not.toContain('Add an agent');
    expect(names).toContain('Sign in');
  });

  it('a click opens one card, and only that card', async () => {
    await mount();
    const sign = cards().find((c) => c.getAttribute('data-group') === 'Sign in')!;
    await act(async () => sign.querySelector<HTMLElement>('.st-adv-toggle')!.click());
    await settle(3);
    const after = cards().find((c) => c.getAttribute('data-group') === 'Sign in')!;
    expect(after.getAttribute('data-open')).toBe('true');
    expect(after.querySelector('[data-row="accounts"]')).not.toBeNull();
    expect(cards().filter((c) => c.getAttribute('data-open') === 'true')).toHaveLength(1);
  });
});
