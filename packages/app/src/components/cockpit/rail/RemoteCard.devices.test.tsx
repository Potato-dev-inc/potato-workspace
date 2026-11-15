// @vitest-environment jsdom
// "Connect a computer" in the agent's Remote control card: with Labs Devices on it points to Settings > Devices; off, it is the
// phone's pairing steps as before.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEnglish } from '../../../i18n/test-utils';
import { RemoteCard, type RemoteApi } from './RemoteCard';

const settings = vi.hoisted(() => ({ on: false }));
vi.mock('../../../lib/settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/settings')>()),
  loadSettings: async () => ({ devices_enabled: settings.on }),
}));
const openAt = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/openSettingsAt', () => ({ openSettingsAt: openAt }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  useEnglish();
  openAt.mockClear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const api: RemoteApi = { get: vi.fn(async () => ({ remote: true, level: 'full' as const })), set: vi.fn(), phones: vi.fn(async () => []) };
const mount = async () => {
  await act(async () => root.render(<RemoteCard paneId="p1" api={api} />));
  await act(async () => {});
  await act(async () => {});
};
const connect = () => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Connect a computer')!;

describe('RemoteCard: Connect a computer', () => {
  it('opens Settings > Devices while Labs Devices is on', async () => {
    settings.on = true;
    await mount();
    expect(connect().title).toBe('Pair another PC in Settings › Devices');
    await act(async () => connect().click());
    expect(openAt).toHaveBeenCalledWith('devices');
  });

  it('is the phone pairing steps while it is off', async () => {
    settings.on = false;
    await mount();
    expect(connect().title).toBe('Another computer uses the same pairing steps for now');
    await act(async () => connect().click());
    expect(openAt).toHaveBeenCalledWith('phone');
  });
});
