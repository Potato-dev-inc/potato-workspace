// @vitest-environment jsdom
// The Agents page reads usage with the person's own "read usage with my sign-in" setting, never a fixed one: the desktop keeps one switch for every
// usage read, so a fixed `false` here turned the status bar's chips into "Usage not shared" while this page was open.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

let settings: { usage_login_reads?: boolean } = {};
vi.mock('../../../lib/settings', async (orig) => ({ ...(await orig<object>()), loadSettings: async () => settings }));

import type { UsageApi } from '../../../lib/usage';
import { useCardData, type CardApis } from './AgentCard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function asked(setting: { usage_login_reads?: boolean }) {
  settings = setting;
  const snapshot = vi.fn(async () => ({ rows: [], refreshed_at_ms: 0 }));
  const usage: UsageApi = { snapshot, openPage: async () => undefined, onChanged: async () => () => undefined };
  const apis = { accounts: { list: async () => ({ accounts: [] }) }, usage, logins: async () => [] } as unknown as CardApis;
  const Probe = () => (useCardData(apis), null);
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () => root.render(<Probe />));
  for (let i = 0; i < 6; i++) await act(async () => {});
  await act(async () => root.unmount());
  return snapshot.mock.calls;
}

describe('the Agents page usage read', () => {
  it('asks with login reads on by default', async () => {
    expect(await asked({})).toEqual([[false, true]]);
  });
  it('asks with login reads off only when the person turned them off', async () => {
    expect(await asked({ usage_login_reads: false })).toEqual([[false, false]]);
  });
});
