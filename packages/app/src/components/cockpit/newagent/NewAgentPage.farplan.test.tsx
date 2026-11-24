// @vitest-environment jsdom
// Another PC's New agent page says what a plain start there will run on: its own sign-in, the sign-in this PC lent it, or (signed out, nothing
// lent) that it isn't signed in, with Start off for a chat that could not answer.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcpAddonApi, AddonStatus } from '../../../lib/acpAddon';
import type { AgentDescriptor } from '../../../lib/agentRegistry';
import { forceShowTerminals } from '../../../lib/showTerminals';
import type { RecentProject } from '../../../lib/ship-api';
import { setLanguagePref } from '../../../i18n';
import type { NewAgentApi } from './api';
import type { LaneView } from './model';
import type { FarPlan } from './useFarPlan';
import { NewAgentPage, type NewAgentPageProps } from './NewAgentPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const agents = [{ id: 'claude', label: 'Claude', kind: 'cli', installed: true, modes: { headless: true, visible: true } } as unknown as AgentDescriptor];
const project: RecentProject = { path: 'remote:p1', name: 'work-test', state: 'repo', last_used_ms: 5 };
const lanes: LaneView = { labsEnabled: true, agents: [{ id: 'claude', lane: 'terminal', disabled: false }] };
const installed = (id: string): AddonStatus => ({ agent: id, label: id, state: 'installed', version: '1', pinned_version: '1', detail: '', size_mb: 1, lines: [], signin_hint: '' });
const addonApi: AcpAddonApi = { list: async () => ({ labsEnabled: true, addons: [installed('claude')] }), install: vi.fn(async (id: string) => installed(id)), remove: vi.fn(async (id: string) => installed(id)), watch: async () => () => undefined };
const api = (): NewAgentApi => ({
  recent: async () => [project],
  pickFolder: async () => null,
  pickPaths: async () => [],
  defaultFolder: async () => null,
  gitState: async () => 'repo',
  lanes: async () => lanes,
  accounts: async () => [],
  loadHome: async () => ({ name: '', cards: [] }),
  saveCards: async () => undefined,
  onHomeChanged: async () => () => undefined,
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  forceShowTerminals(false);
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  forceShowTerminals(true);
  setLanguagePref('en', false);
  await act(async () => root.unmount());
  host.remove();
});

async function mount(plan: FarPlan | null, props: Partial<NewAgentPageProps> = {}) {
  await act(async () => {
    root.render(
      <NewAgentPage agents={agents} panes={[]} needs={[]} api={api()} addonApi={addonApi} onStart={vi.fn(async () => undefined)} onSignIn={vi.fn()} onOpenPane={vi.fn()} remote={{ deviceName: 'pm-sandbox', terminals: false, blocked: null, plan: async () => plan }} {...props} />,
    );
  });
  await act(async () => {});
  await act(async () => {});
}
const line = () => document.querySelector('[data-testid="na-runs-on"]')?.textContent ?? '';
const start = () => document.querySelector<HTMLButtonElement>('button[aria-label="Start"]')!;

describe('what a start on another PC runs on', () => {
  it('its own sign-in when it is signed in (or says nothing)', async () => {
    await mount({ signedOut: false, lend: null });
    expect(line()).toBe('Runs on pm-sandbox with its Claude sign-in.');
  });

  it('names the borrowed sign-in when the far PC is signed out and this PC lent it one', async () => {
    await mount({ signedOut: true, lend: { grantId: 'lg1', name: 'ren lend claude' } });
    expect(line()).toBe('Runs on pm-sandbox using ren lend claude.');
  });

  it('says it is not signed in, with the real options, and does not start a chat that cannot answer', async () => {
    await mount({ signedOut: true, lend: null });
    const box = document.querySelector<HTMLTextAreaElement>('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'fix the tests');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(line()).toContain("pm-sandbox's Claude isn't signed in. Sign in there, or ask there to borrow a sign-in.");
    expect(start().disabled).toBe(true);
    expect(start().title).toBe("pm-sandbox's Claude isn't signed in.");
  });

  it('in Chinese too', async () => {
    setLanguagePref('zh-TW', false);
    await mount({ signedOut: true, lend: { grantId: 'lg1', name: 'ren lend claude' } });
    expect(line()).toBe('在 pm-sandbox 上執行，使用 ren lend claude。');
  });
});
