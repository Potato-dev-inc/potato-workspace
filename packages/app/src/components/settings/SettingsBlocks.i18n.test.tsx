// @vitest-environment jsdom
// The Settings blocks that need a desktop shell to show anything (Team, Lend, paired phones), drawn with fake backends in
// Traditional Chinese: no visible English. Names, hosts and codes the fixtures hold are people's words, not ours.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PairedDeviceInfo } from '@potato-workspace/shared';
import { teamConfig } from '../../dev/team-fixtures';
import { GRANT_IN, GRANT_OUT, LEND_MEMBERS, lendState } from '../../dev/lend-fixtures';
import { useChinese, useEnglish, visibleEnglish } from '../../i18n/test-utils';
import type { LendApi } from '../../lib/lend';
import type { TeamApi } from '../../lib/team';
import { PairedDevices } from './blocks/PairedDevices';
import { LendPage } from './blocks/LendPage';
import { TeamPage } from './blocks/TeamPage';
import { click, hasText, settle } from './test-utils';

vi.mock('qrcode', () => ({ default: { toCanvas: vi.fn(async () => undefined) } }));
const mocks = vi.hoisted(() => ({ devices: [] as unknown[] }));
vi.mock('../../lib/tauri', () => ({
  tauri: {
    listPairedMobileDevices: vi.fn(async () => mocks.devices),
    revokePairedMobileDevice: vi.fn(async () => true),
    setPairedMobileDeviceCaps: vi.fn(async () => true),
  },
}));

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
  useEnglish();
});

/** What stays as the fixtures wrote it: people, devices, hosts, codes and product names. */
const ALLOW = ['Maya', 'Leo', 'Pat', 'Acme', 'Pixel', 'Claude', 'Codex', 'Cloudflare', 'Zero', 'Trust', 'Dropbox', 'Docker', 'Workers', 'MacBook', 'laptop', 'GitHub', 'pm', 'team', 'join', 'Zhang', 'Wang', 'Kim', 'Sam', 'Ana', 'maya', 'leo', 'github', 'Studio', 'desktop', 'Edit', 'Use', 'template', 'Continue', 'summary', 'Create', 'Token', 'Priya', 'priya', 'dev', 'samc', 'Credential', 'Manager', 'My', 'other', 'PCs', 'Teammates', 'ask', 'first', "Priya's", "Maya's", "Sam's", 'tokens', 'desktop', 'priya-dev', 'leo-dev', 'maya-dev'];

/** What a block says about itself. A sentence the agent's own lend spec brings (a driver note from the backend) is not ours. */
const english = (el: Element): string[] => visibleEnglish(el, ALLOW).filter((line) => !/is not supported yet/.test(line));

function teamApi(view = teamConfig()): TeamApi {
  const same = async () => view;
  return {
    configGet: same,
    defaultName: async () => 'Pat',
    configSet: same,
    create: same,
    invite: async () => ({ link: 'pm://team/join?t=Acme&k=abc123', code: 'KQ7M-4XPD', expiresAtMs: Date.now() + 600_000 }),
    join: same,
    leave: same,
    approveJoin: same,
    declineJoin: same,
    removeMember: same,
    confirmGithub: same,
    deployRelay: async () => ({ status: 'done', url: 'https://pm-relay.maya.workers.dev' }),
    onRelayDeployStep: async () => () => {},
    onChanged: async () => () => {},
  } as unknown as TeamApi;
}

const NOT_ON_TEAM = { enabled: false, team: '', teamName: '', relay: '', name: '', members: [], joins: [], admin: false, transport: null, link: null };

describe('Settings blocks in Traditional Chinese have no visible English', () => {
  it('Team: the two choices, then the start form and the join form', async () => {
    await act(async () => root.render(<TeamPage api={teamApi(teamConfig(NOT_ON_TEAM))} />));
    await settle(5);
    expect(english(host)).toEqual([]);
    await click(host.querySelectorAll<HTMLButtonElement>('.tp-choice')[0]);
    await settle(3);
    expect(hasText(host, '建立團隊')).toBe(true);
    await click([...host.querySelectorAll('button')].find((b) => b.textContent?.includes('其他方式'))!);
    expect(english(host)).toEqual([]);
    await click([...host.querySelectorAll('button')].find((b) => b.textContent === '返回')!);
    await click(host.querySelectorAll<HTMLButtonElement>('.tp-choice')[1]);
    await settle(3);
    expect(hasText(host, '加入團隊')).toBe(true);
    expect(english(host)).toEqual([]);
  });

  it('Team: a team that exists (status, invite, people, options)', async () => {
    await act(async () => root.render(<TeamPage api={teamApi(teamConfig({ members: LEND_MEMBERS }))} />));
    await settle(5);
    await click([...host.querySelectorAll('button')].find((b) => b.textContent?.includes('選項'))!);
    expect(host.textContent).toContain('使用團隊功能');
    expect(english(host)).toEqual([]);
  });

  it('paired phones: the abilities and the expiry line', async () => {
    mocks.devices = [
      { id: '00000000-0000-4000-8000-000000000001', name: 'Pixel 8', public_key: 'k', paired_at: 1, caps: ['watch', 'answer'], idle_expiry_secs: 30 * 86400, expired: false },
    ] as PairedDeviceInfo[];
    await act(async () => root.render(<PairedDevices />));
    await settle(5);
    expect(host.textContent).toContain('查看');
    expect(host.textContent).toContain('使用中');
    expect(english(host)).toEqual([]);
  });

  it('Lend: profiles, the profile editor and the active lends', async () => {
    const api: LendApi = {
      state: async () => lendState({ grants: [GRANT_OUT, GRANT_IN] }),
      onChanged: async () => () => {},
    } as unknown as LendApi;
    const team = teamApi(teamConfig({ members: LEND_MEMBERS }));
    const accountsApi = { list: async () => ({ agents: [], accounts: [], helper_logins: {}, borrowed: [] }) } as never;
    await act(async () => root.render(<LendPage api={api} team={team} accountsApi={accountsApi} />));
    await settle(6);
    expect(host.textContent).toContain('出借設定檔');
    expect(host.textContent).toContain('進行中的出借');
    expect(english(host)).toEqual([]);
    await click([...host.querySelectorAll('button')].find((b) => b.textContent === '新增設定檔')!);
    await settle(3);
    expect(host.querySelector('.lend-editor')).not.toBeNull();
    expect(english(host)).toEqual([]);
  });
});
