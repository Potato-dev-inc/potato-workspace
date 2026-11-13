// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountsApi } from '../../lib/accounts';
import type { ShipApi } from '../../lib/ship-api';
import { t } from '../../i18n';
import { useChinese, useEnglish, visibleEnglish } from '../../i18n/test-utils';
import { NewAgentMenu } from './NewAgentMenu';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const accountsApi = { list: async () => ({ agents: [], accounts: [] }), add: vi.fn(), rename: vi.fn(), remove: vi.fn(), openLoginPane: vi.fn() } as unknown as AccountsApi;
const ship = {
  recent: async () => [
    { path: 'C:/work/shop', name: 'shop', state: 'repo', last_used_ms: 3 },
    { path: 'C:/work/plain', name: 'plain', state: 'folder', last_used_ms: 2 },
  ],
  gitInitPlan: async () => ({ files: 3, too_big: false, gitignore: ['node_modules'], commands: ['git init'] }),
  forget: async () => undefined,
  pickFolder: async () => null,
} as unknown as ShipApi;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  useChinese();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  window.localStorage.clear();
  useEnglish();
});

const EXTRA = ['shop', 'plain', 'Claude', 'Codex', 'Kilo', 'git', 'init', 'node_modules', 'node', 'modules', 'gitignore', 'env', 'Keeps', 'Nothing', 'No', 'yet', 'Git', 'snapshot'];
const button = (text: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes(text));

async function mount() {
  await act(async () => {
    root.render(
      <NewAgentMenu
        entries={[
          { type: 'claude', label: 'Claude' },
          { type: 'codex', label: 'Codex' },
          { type: 'kilo', label: 'Kilo', disabled: true },
        ]}
        readyAgents={new Set(['codex'])}
        onStart={vi.fn()}
        onClose={vi.fn()}
        accountsApi={accountsApi}
        ship={ship}
        project={{ path: 'C:/work/plain', name: 'plain', state: 'folder' }}
        onProject={vi.fn()}
        isolated={false}
        onIsolated={vi.fn()}
        onOpenStore={vi.fn()}
        onStartMission={vi.fn()}
        onTonight={vi.fn()}
      />,
    );
  });
  await act(async () => {});
}

describe('New agent menu in Traditional Chinese', () => {
  it('shows the agent list in Chinese', async () => {
    await mount();
    expect(host.textContent).toContain(t('newAgent.title'));
    expect(host.textContent).toContain(t('newAgent.moreAgents'));
    expect(host.textContent).toContain(t('newAgent.editList'));
    expect(host.textContent).toContain(t('firstRun.agentFound'));
    expect(visibleEnglish(host, EXTRA)).toEqual([]);
  });

  it('shows the project list and the Git step in Chinese', async () => {
    await mount();
    await act(async () => host.querySelector<HTMLButtonElement>('.ck-chip')!.click());
    await act(async () => {});
    expect(host.textContent).toContain(t('newAgent.menuRecent'));
    expect(host.textContent).toContain(t('newAgent.menuChooseFolder'));
    await act(async () => button('plain')!.click());
    await act(async () => {});
    expect(host.textContent).toContain(t('newAgent.setUpGit'));
    expect(visibleEnglish(host, EXTRA)).toEqual([]);
  });

  it('shows the hidden-agents editor in Chinese', async () => {
    await mount();
    await act(async () => button(t('newAgent.editList').replace('…', ''))!.click());
    expect(host.textContent).toContain(t('newAgent.hiddenShowAll'));
    expect(visibleEnglish(host, EXTRA)).toEqual([]);
  });
});
