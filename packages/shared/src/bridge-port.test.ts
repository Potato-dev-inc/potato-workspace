import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BRIDGE_PORT_FILE_ENV } from './protocol.js';
import { isLoopbackHost, parseBridgePort, readAllBridgePorts, readLocalSecretHeaders } from './bridge-port.js';

describe('bridge port discovery', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
  });

  it('accepts only loopback hosts', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('10.0.0.5')).toBe(false);
    expect(isLoopbackHost('evil.example.com')).toBe(false);
    expect(parseBridgePort('127.0.0.1:17321\n')).toEqual({ host: '127.0.0.1', port: 17321 });
    expect(parseBridgePort('17321')).toEqual({ host: '127.0.0.1', port: 17321 });
    expect(parseBridgePort('evil.example.com:17321')).toBeNull();
    expect(parseBridgePort('0.0.0.0:17321')).toBeNull();
  });

  it('skips a port file that names a remote host', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pm-bridge-port-'));
    dirs.push(dir);
    const file = join(dir, 'potato-workspace.bridge.port');
    await writeFile(file, 'evil.example.com:17321');
    expect(await readAllBridgePorts(file)).toEqual([]);
    await writeFile(file, '127.0.0.1:17321');
    expect(await readAllBridgePorts(file)).toEqual([{ host: '127.0.0.1', port: 17321 }]);
  });

  it('does not look for a port file in the current directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pm-bridge-cwd-'));
    dirs.push(dir);
    await writeFile(join(dir, 'potato-workspace.bridge.port'), '127.0.0.1:1');
    const prevCwd = process.cwd();
    const prevEnv = process.env[BRIDGE_PORT_FILE_ENV];
    delete process.env[BRIDGE_PORT_FILE_ENV];
    process.chdir(dir);
    try {
      const found = await readAllBridgePorts();
      expect(found.some((f) => f.port === 1)).toBe(false);
    } finally {
      process.chdir(prevCwd);
      if (prevEnv !== undefined) process.env[BRIDGE_PORT_FILE_ENV] = prevEnv;
    }
  });

  it('sends the pane id from the shell environment so the bridge treats the call as that agent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pm-bridge-port-'));
    dirs.push(dir);
    const file = join(dir, 'potato-workspace.bridge.port');
    await writeFile(file, '127.0.0.1:17321');
    await writeFile(join(dir, 'potato-workspace.bridge.secret'), 'abc123');
    const before = process.env.POTATO_WORKSPACE_PANE_ID;
    try {
      process.env.POTATO_WORKSPACE_PANE_ID = 'pane-7';
      expect(await readLocalSecretHeaders(file)).toEqual({
        'X-Potato-Workspace-Local-Secret': 'abc123',
        'X-Potato-Workspace-Pane': 'pane-7',
      });
      delete process.env.POTATO_WORKSPACE_PANE_ID;
      expect(await readLocalSecretHeaders(file)).toEqual({ 'X-Potato-Workspace-Local-Secret': 'abc123' });
    } finally {
      if (before === undefined) delete process.env.POTATO_WORKSPACE_PANE_ID;
      else process.env.POTATO_WORKSPACE_PANE_ID = before;
    }
  });
});
