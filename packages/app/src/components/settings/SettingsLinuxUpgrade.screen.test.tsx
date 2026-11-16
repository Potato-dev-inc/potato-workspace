// POTATO BOT MERGE: if this conflicts with or duplicates Potato Bot's WSL code, keep Potato Bot's original WSL implementation and drop this one.
// @vitest-environment jsdom
// Settings > Agents > Run agents in Linux, and the update and recovery rows: a WSL 1 distro shows an "Upgrade" button and no
// command text; the button upgrades by itself and refreshes the list; after a failure an agent is offered; the update row
// checks by itself when it opens; damaged settings show the banner with Undo. WSL is mocked: nothing runs on this PC.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wslPlacesGet, wslStatus, wslUpgrade, type WslStatus } from '../../lib/wsl';
import type { UpdateTransport } from '../../lib/app-update';
import { buttonByText, click, hasText, mountRows, settle, type Mounted } from './test-utils';
import { LinuxRows } from './sections/LinuxRows';
import { UpdateRow } from './sections/UpdateRow';
import { SettingsDamagedBanner } from './SettingsDamagedBanner';

vi.mock('../../lib/addAgentActions', () => ({ requestAddAgentAction: vi.fn() }));
vi.mock('../../lib/workerUpdate', () => ({ loadAgentView: async () => ({}), pickHandoffAgent: () => ({ id: 'fake_a', label: 'Agent A' }) }));
vi.mock('../../lib/wsl', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/wsl')>()),
  wslStatus: vi.fn(),
  wslPlacesGet: vi.fn(),
  wslUpgrade: vi.fn(),
}));

const WSL1: WslStatus = { state: 'ready', distros: [{ name: 'Debian-Test', default: true, version: 1, state: 'Stopped' }] };
const WSL2: WslStatus = { state: 'ready', distros: [{ name: 'Debian-Test', default: true, version: 2, state: 'Stopped' }] };

let m: Mounted;
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(wslPlacesGet).mockResolvedValue([]);
});
afterEach(async () => {
  await m?.unmount();
});

async function mountLinux(status: WslStatus) {
  vi.mocked(wslStatus).mockResolvedValue(status);
  m = await mountRows([{ id: 'linux', label: 'Run agents in Linux (WSL)', group: 'Linux', render: (env) => <LinuxRows onSaved={env.markSaved} /> }]);
  await settle(10);
}

describe('WSL upgrade screen', () => {
  it('a WSL 1 row shows Upgrade and no command text; the button upgrades and the row turns WSL 2', async () => {
    await mountLinux(WSL1);
    expect(hasText(m.host, 'Debian-Test (default) · WSL 1')).toBe(true);
    expect(m.host.textContent).not.toMatch(/--set-version|wsl --/);
    vi.mocked(wslUpgrade).mockResolvedValue(WSL2);
    await click(buttonByText(m.host, 'Upgrade'));
    await settle(8);
    expect(wslUpgrade).toHaveBeenCalledExactlyOnceWith('Debian-Test');
    expect(hasText(m.host, 'Debian-Test (default) · WSL 2')).toBe(true);
    expect(buttonByText(m.host, 'Upgrade')).toBeUndefined();
  });

  it('shows progress while it works, and after a failure says so and offers an agent (still no command)', async () => {
    await mountLinux(WSL1);
    let fail!: (e: Error) => void;
    vi.mocked(wslUpgrade).mockReturnValue(new Promise<WslStatus>((_, reject) => (fail = reject)));
    await click(buttonByText(m.host, 'Upgrade'));
    await settle();
    expect(hasText(m.host, 'Upgrading Debian-Test. This can take a few minutes.')).toBe(true);
    expect(buttonByText(m.host, 'Upgrade')!.disabled).toBe(true);
    fail(new Error('WSL_START_FAILED: The upgrade did not work.'));
    await settle(8);
    expect(hasText(m.host, 'The upgrade did not work.')).toBe(true);
    expect(buttonByText(m.host, 'Let an agent fix it')).toBeTruthy();
    expect(m.host.textContent).not.toMatch(/--set-version/);
  });
});

describe('Update check and settings recovery run by themselves', () => {
  it('the update row checks quietly when it opens, without a press', async () => {
    const check = vi.fn(async () => null);
    const transport = { check, busy: async () => [], tools: async () => null } as unknown as UpdateTransport;
    m = await mountRows([{ id: 'update', label: 'Version', group: 'About', render: () => <UpdateRow transport={transport} versionLine="1.1.8" /> }]);
    await settle(8);
    expect(check).toHaveBeenCalled();
  });

  it('damaged settings show the banner with Undo', async () => {
    const api = { status: vi.fn(async () => ({ damaged: true, hasBackup: true })), restore: vi.fn(async () => undefined), dismiss: vi.fn(async () => undefined) };
    m = await mountRows([{ id: 'dmg', label: 'Damaged', group: 'About', render: () => <SettingsDamagedBanner api={api as never} /> }]);
    await settle(5);
    expect(hasText(m.host, 'Your settings file was damaged')).toBe(true);
    await click(buttonByText(m.host, 'Undo'));
    await settle(4);
    expect(api.restore).toHaveBeenCalledTimes(1);
  });
});
