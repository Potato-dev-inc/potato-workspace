// @vitest-environment jsdom
// Labs is a real page in the Settings nav (it replaces the cut-off link at the bottom). Rendered through the real panel.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SECTIONS } from './settings/catalog';
import { findRowSection } from './settings/model';
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
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const mount = async (props: Partial<React.ComponentProps<typeof SettingsPanel>> = {}) => {
  await act(async () => root.render(<SettingsPanel open inline api={api} {...props} />));
  await settle(6);
};
const nav = () => [...host.querySelectorAll('.st-nav .st-nav-row')];
const navLabels = () => nav().map((b) => b.textContent);
const main = () => host.querySelector('.st-main') as HTMLElement;

describe('Labs is a real page in the Settings nav', () => {
  it('the nav lists Labs as a page, between Shortcuts and Advanced', async () => {
    await mount();
    expect(navLabels()).toEqual(['Overview', 'Agents', 'Agents that agents start', 'Look and feel', 'Keys', 'Shortcuts', 'Labs', 'Advanced']);
  });

  it('the old cut-off link at the bottom of the nav is gone', async () => {
    await mount();
    expect(host.querySelector('.st-labs-nav')).toBeNull();
  });

  it('opening Labs marks its nav row as the current page and shows the Labs title and the early features', async () => {
    await mount({ initialTab: 'labs' });
    const labsRow = nav().find((b) => b.textContent === 'Labs');
    expect(labsRow?.getAttribute('aria-current')).toBe('page');
    expect(main().querySelector('h1')?.textContent).toBe('Labs');
    expect(main().textContent).toContain('Simple mode');
  });

  it('the Labs index row (the old labs-index link) lives on the Labs page', () => {
    expect(findRowSection(SECTIONS, 'labs-index')?.id).toBe('labs');
  });

  it('the Chat view flag is no longer a row anywhere', () => {
    const ids = SECTIONS.flatMap((s) => s.rows.map((r) => r.id));
    expect(ids).not.toContain('acp-chat-labs');
  });

  it('the other early features keep their own switch or Open button on the Labs page', async () => {
    await mount({ initialTab: 'labs' });
    expect(main().querySelectorAll('.st-labs-feature').length).toBeGreaterThan(5);
    expect(main().querySelector('[aria-label*="Ask bar"]')).not.toBeNull();
  });
});
