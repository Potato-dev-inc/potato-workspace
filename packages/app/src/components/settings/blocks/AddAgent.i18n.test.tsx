// @vitest-environment jsdom
// "Add an agent" in Traditional Chinese: no English left on the idle, checking, install, done, failed and Advanced screens.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ERROR_COPY, type AddAgentApi, type AddAgentRun } from '../../../lib/addAgent';
import { mockAddAgentApi } from '../../../lib/addAgent.mocks';
import { t } from '../../../i18n';
import { useChinese, useEnglish, visibleEnglish } from '../../../i18n/test-utils';
import { click, settle, type as typeInto } from '../test-utils';
import { AddAgent } from './AddAgent';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => undefined) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const DATA = ['fakenat', 'Fakenat', 'fakereg', 'Fakereg', 'fakegone', 'Fakegone', 'fakeauth', 'Fakeauth', 'kimi', 'npm', 'install', 'prefix', 'add', 'ons', 'acp', 'registry', 'npmjs', 'org', 'fakegone'];

beforeEach(() => {
  useChinese();
  vi.useFakeTimers();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  globalThis.sessionStorage.clear();
  useEnglish();
});

const mount = async (api: AddAgentApi) => {
  await act(async () => root.render(<AddAgent api={api} />));
  await settle();
};
const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};
const addIt = async (value: string) => {
  await typeInto(host.querySelector('input') as HTMLInputElement, value);
  await click(host.querySelector('button[type="submit"]'));
};
const text = () => host.textContent ?? '';

describe('Add an agent in zh-TW', () => {
  it('idle screen, with agents found on this computer and the Advanced box', async () => {
    const api = {
      ...mockAddAgentApi('native_ok'),
      detectInstalled: vi.fn(async () => [
        { id: 'a', displayName: 'Fakenat', path: 'x', kind: 'native', version: null },
        { id: 'b', displayName: 'Fakereg', path: 'y', kind: 'native', version: null },
      ]),
    };
    await mount(api);
    expect(text()).toContain(t('addAgent.found.title'));
    expect(text()).toContain(t('addAgent.found.addAll'));
    expect(visibleEnglish(host, DATA)).toEqual([]);
    await click(Array.from(host.querySelectorAll('button')).find((b) => b.textContent === t('addAgent.advanced')));
    expect(text()).toContain(t('addAgent.adv.wizard'));
    expect(visibleEnglish(host, DATA)).toEqual([]);
  });

  it('checking and a finished chat agent with chips', async () => {
    await mount(mockAddAgent());
    await addIt('fakenat');
    await advance(300);
    expect(text()).toContain(t('addAgent.adding', { name: 'Fakenat' }));
    expect(visibleEnglish(host, DATA)).toEqual([]);
    await advance(5000);
    expect(text()).toContain(t('addAgent.isReady', { name: 'Fakenat' }));
    expect(text()).toContain(t('addAgent.startChat'));
    expect(visibleEnglish(host, DATA)).toEqual([]);
  });

  it('install question and the copy-the-command screen', async () => {
    await mount(mockAddAgentApi('registry_addon'));
    await addIt('fakereg');
    await advance(1500);
    expect(text()).toContain(t('addAgent.install.addonBtn'));
    expect(visibleEnglish(host, DATA)).toEqual([]);
  });

  it('cannot install: command screen', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => undefined) }, configurable: true });
    await mount(mockAddAgentApi('not_installed'));
    await addIt('fakegone');
    await advance(700);
    expect(text()).toContain(t('addAgent.install.checkAgain'));
    expect(visibleEnglish(host, DATA)).toEqual([]);
  });

  it.each(Object.entries(ERROR_COPY))('failure %s is in Chinese', async (code, row) => {
    const run: AddAgentRun = {
      run_id: 'r1', input: 'fakenat', agent_id: null, label: 'Fakenat', state: 'failed', started_ms: 1, steps: [], install: null, result: null,
      error: { code, message: row.message, action: row.action, step: null },
    };
    const api: AddAgentApi = {
      start: vi.fn(async () => run), status: vi.fn(async () => run), cancel: vi.fn(async () => run), approveInstall: vi.fn(async () => run),
      onProgress: vi.fn(async () => () => undefined),
    };
    await mount(api);
    await addIt('fakenat');
    expect(visibleEnglish(host, DATA)).toEqual([]);
  });
});

function mockAddAgent(): AddAgentApi {
  return mockAddAgentApi('native_ok');
}
