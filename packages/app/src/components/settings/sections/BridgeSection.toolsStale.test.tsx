// @vitest-environment jsdom
// Settings > Bridge > Connection check lists the agents whose tools are out of date, each with Reconnect; Reconnect
// restarts that agent and the line goes away once the app reports it up to date.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buttonByText, click, hasText, mountRows, settle, type Mounted } from '../test-utils';
import { bridgeRows } from './BridgeSection';

const mocks = vi.hoisted(() => ({
  drift: [] as { paneId: string | null; agentCatalog: string; appCatalog: string; canReconnect: boolean }[],
  failWith: null as string | null,
}));

vi.mock('../../../lib/mcp-config', () => ({
  POTATO_WORKSPACE_MCP_COMMAND: { command: 'npx', args: ['-y', '@potato-workspace/mcp'] },
  getMcpStatus: vi.fn(async () => ({
    bridgeReachable: true, bridgeUrl: 'http://127.0.0.1:17321', bridgeVersion: '1.0', portFileExists: true, portFilePath: 'p',
    nodeAvailable: true, npmAvailable: true, npmPackageVersion: '1', launchCommand: 'x', backends: [], overallReady: true, repairResults: [],
  })),
  installNpmMcpConfigs: vi.fn(),
  installGlobalNpmMcpConfigs: vi.fn(),
  uninstallNpmMcpConfigs: vi.fn(),
  uninstallGlobalNpmMcpConfigs: vi.fn(),
}));

vi.mock('../../../lib/mcp-drift', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/mcp-drift')>();
  return {
    ...actual,
    mcpToolsDrift: vi.fn(async () => mocks.drift),
    mcpReconnect: vi.fn(async () => {
      if (mocks.failWith) throw new Error(mocks.failWith);
      mocks.drift = [];
    }),
  };
});

vi.mock('../toolbelt/ToolbeltGroup', async () => {
  const { createElement } = await import('react');
  return { ToolbeltGroup: () => createElement('section', null, 'Toolbelt stub') };
});

import { mcpReconnect } from '../../../lib/mcp-drift';

let m: Mounted;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.drift = [];
  mocks.failWith = null;
});
afterEach(async () => {
  await m?.unmount();
});

async function mount() {
  m = await mountRows(bridgeRows, {});
  await settle(6);
}

describe('Connection check and out-of-date tools', () => {
  it('shows nothing when every agent has the app tool list', async () => {
    await mount();
    expect(m.host.querySelector('[data-tools-stale-list]')).toBeNull();
  });

  it('lists the stale agent and Reconnect clears it', async () => {
    mocks.drift = [{ paneId: 'pane-1', agentCatalog: 'old', appCatalog: 'new', canReconnect: true }];
    await mount();
    expect(m.host.querySelector('[data-tools-stale-list]')).not.toBeNull();
    expect(hasText(m.host, 'Tools are out of date.')).toBe(true);
    await click(buttonByText(m.host, 'Reconnect'));
    await settle(6);
    expect(mcpReconnect).toHaveBeenCalledWith('pane-1');
    expect(m.host.querySelector('[data-tools-stale-list]')).toBeNull();
  });

  it('says what to do for a program the app cannot restart', async () => {
    mocks.drift = [{ paneId: null, agentCatalog: 'old', appCatalog: 'new', canReconnect: false }];
    await mount();
    expect(hasText(m.host, 'A program on this computer')).toBe(true);
    expect(buttonByText(m.host, 'Reconnect')).toBeUndefined();
  });

  it('keeps the line and says why when the reconnect fails', async () => {
    mocks.drift = [{ paneId: 'pane-1', agentCatalog: 'old', appCatalog: 'new', canReconnect: true }];
    mocks.failWith = 'BUSY: The agent is working. Wait for it to finish, then reconnect.';
    await mount();
    await click(buttonByText(m.host, 'Reconnect'));
    await settle(6);
    expect(m.host.querySelector('[data-tools-stale-list]')).not.toBeNull();
    expect(hasText(m.host, 'The agent is working. Wait for it to finish, then reconnect.')).toBe(true);
  });
});
