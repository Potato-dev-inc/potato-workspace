// @vitest-environment jsdom
// Over SSH as a whole screen, through the real Settings > Devices page: Add a device > Over SSH (the form, Check, the list of what is
// there), each failure in its own plain words, Save into the "SSH machines" list, Check again, Remove. Only the SSH command layer
// is the fake (`SshFake`): no real SSH host is ever contacted.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DevicesFake } from '../../dev/devices-fixtures';
import { BUILD_BOX, CHECK_OK, SshFake, failed } from '../../dev/ssh-fixtures';
import { click, settle, type as typeInto } from '../settings/test-utils';
import { DevicesPage } from './DevicesPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = '';
});

const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);

async function mount(ssh: SshFake) {
  await act(async () => root.render(<DevicesPage api={new DevicesFake({ enabled: true })} ssh={ssh} />));
  await settle(6);
  await click(q('[data-testid="add-device"]'));
  await click(q('[data-testid="add-tab-ssh"]'));
  await settle(2);
}

const fill = async (target: string, port?: string, key?: string) => {
  await typeInto(q<HTMLInputElement>('[data-testid="ssh-target"]')!, target);
  if (port !== undefined) await typeInto(q<HTMLInputElement>('[data-testid="ssh-port"]')!, port);
  if (key !== undefined) await typeInto(q<HTMLInputElement>('[data-testid="ssh-key"]')!, key);
};

describe('Add a device > Over SSH', () => {
  it('the SSH way in is open, has no password field, and a bad address is told how to be typed', async () => {
    await mount(new SshFake());
    expect(q<HTMLButtonElement>('[data-testid="add-tab-ssh"]')!.disabled).toBe(false);
    expect(q('[data-testid="ssh-form"]')).not.toBeNull();
    expect(document.querySelector('input[type="password"]')).toBeNull();
    await fill('build.local');
    await click(q('[data-testid="ssh-check"]'));
    expect(q('[data-testid="ssh-bad-address"]')!.textContent).toBe('Type it like ren@build-box.local');
    await fill('dev@build.local');
    await typeInto(q<HTMLInputElement>('[data-testid="ssh-port"]')!, '99999');
    await click(q('[data-testid="ssh-check"]'));
    expect(q('[data-testid="ssh-bad-address"]')).not.toBeNull();
  });

  it('Check passes the parts (the key file as a path) and lists the system, git, node and each agent', async () => {
    const fake = new SshFake({ check: CHECK_OK });
    await mount(fake);
    await fill('dev@build.local', '2222', 'C:\\Users\\me\\.ssh\\id_ed25519');
    await click(q('[data-testid="ssh-check"]'));
    await settle(4);
    expect(fake.calls[0]).toEqual({ method: 'check', args: [{ target: 'dev@build.local', port: 2222, keyFile: 'C:\\Users\\me\\.ssh\\id_ed25519' }] });
    const list = q('[data-testid="ssh-check-list"]')!;
    expect(list.textContent).toContain('dev@build.local answered.');
    expect(q('[data-testid="ssh-os"]')!.textContent).toBe('Linux');
    expect(q('[data-testid="ssh-found-git"]')!.textContent).toBe('git');
    expect(q('[data-testid="ssh-found-node"]')!.textContent).toBe('node');
    expect(q('[data-testid="ssh-found-claude"]')!.textContent).toBe('Claude (terminal)');
    expect(q('[data-testid="ssh-found-codex"]')!.textContent).toBe('Codex: not installed');
    expect(list.textContent).toContain("never reads your key");
    expect((q<HTMLInputElement>('[data-testid="ssh-name"]')!).value).toBe('build.local');
  });

  it.each([
    ['cannot_reach', 'Cannot reach this machine. Check the address, and that it is on.'],
    ['wrong_key', 'Wrong key or password. Check the key file. Or open a terminal: it asks for the password there. Nothing is stored.'],
    ['host_key_unknown', 'This machine is new to this PC. Open a terminal to it once and say yes to its key.'],
    ['host_key_changed', "This machine's key changed. Stopped. Do not go on unless you know why."],
  ] as const)('%s is told in its own words and lists nothing', async (state, words) => {
    await mount(new SshFake({ check: failed(state) }));
    await fill('dev@build.local');
    await click(q('[data-testid="ssh-check"]'));
    await settle(4);
    expect(q(`[data-testid="ssh-state-${state}"]`)!.textContent).toBe(words);
    expect(q('[data-testid="ssh-check-list"]')).toBeNull();
  });

  it('a line from the far machine is shown as plain text', async () => {
    await mount(new SshFake({ check: failed('other', 'Something odd <b>x</b>') }));
    await fill('dev@build.local');
    await click(q('[data-testid="ssh-check"]'));
    await settle(4);
    const alert = q('[data-testid="ssh-state-other"]')!;
    expect(alert.textContent).toBe('The connection did not work: Something odd <b>x</b>');
    expect(alert.querySelector('b')).toBeNull();
  });

  it('Save keeps the machine in the SSH machines list; Check again lists it; Remove forgets it', async () => {
    const fake = new SshFake({ check: CHECK_OK });
    await mount(fake);
    await fill('dev@build.local');
    await click(q('[data-testid="ssh-check"]'));
    await settle(4);
    await typeInto(q<HTMLInputElement>('[data-testid="ssh-name"]')!, 'Build box');
    await click(q('[data-testid="ssh-save"]'));
    await settle(6);
    expect(fake.calls.find((c) => c.method === 'add')!.args[0]).toBe('Build box');
    expect(q('[data-testid="add-device-sheet"]')).toBeNull();
    const row = q('[data-testid="ssh-host-ssh-1"]')!;
    expect(row.textContent).toContain('Build box');
    expect(row.textContent).toContain('dev@build.local');
    expect(row.textContent).toContain('Claude');
    await click(q('[data-testid="ssh-again-ssh-1"]'));
    await settle(4);
    expect(q('[data-testid="ssh-list-ssh-1"]')!.textContent).toContain('Codex: not installed');
    await click(q('[data-testid="ssh-remove-ssh-1"]'));
    await settle(4);
    expect(q('[data-testid="ssh-host-ssh-1"]')).toBeNull();
    expect(q('[data-testid="ssh-empty"]')!.textContent).toBe('No SSH machines yet.');
  });

  it('Set it up saves the machine, runs the setup once, shows its steps, and the finished machine can be updated', async () => {
    const fake = new SshFake({ check: CHECK_OK });
    fake.setupProgress = [
      { id: '', step: 'look', state: 'doing', attempt: 0 },
      { id: '', step: 'look', state: 'done', attempt: 0 },
      { id: '', step: 'copy', state: 'retrying', attempt: 1 },
    ];
    await mount(fake);
    await fill('dev@build.local');
    await click(q('[data-testid="ssh-check"]'));
    await settle(4);
    expect(q('[data-testid="ssh-save"]')!.textContent).toBe('Set it up');
    await click(q('[data-testid="ssh-save"]'));
    await settle(6);
    expect(fake.calls.map((c) => c.method)).toEqual(['check', 'add', 'setup']);
    expect(q('[data-testid="add-device-sheet"]')).toBeNull();
    await click(q('[data-testid="ssh-update-ssh-1"]'));
    await settle(4);
    expect(fake.calls.at(-1)).toEqual({ method: 'update', args: ['ssh-1'] });
  });

  it('a step that fails three times hands over: the fixed line, Copy, Open a shell, and Try again runs only the setup', async () => {
    const line = "/bin/sh -c 'nohup potato-host run'";
    const fake = new SshFake({ check: CHECK_OK });
    fake.setupResult = { ok: false, alreadyCurrent: false, failure: { step: 'start', why: 'step_failed', line: 'bus <b>x</b>', handoff: line } };
    fake.setupProgress = [{ id: '', step: 'start', state: 'retrying', attempt: 2 }];
    const written: string[] = [];
    Object.assign(navigator, { clipboard: { writeText: async (s: string) => void written.push(s) } });
    await mount(fake);
    await fill('dev@build.local');
    await click(q('[data-testid="ssh-check"]'));
    await settle(4);
    await click(q('[data-testid="ssh-save"]'));
    await settle(6);
    expect(q('[data-testid="ssh-step-start"]')!.textContent).toBe('Starting it: that did not work, trying again (2 of 3)');
    const failed = q('[data-testid="ssh-setup-failed"]')!;
    expect(failed.textContent).toContain('A step did not work after three tries. bus <b>x</b>');
    expect(failed.querySelector('b')).toBeNull();
    expect(q('[data-testid="ssh-handoff-line"]')!.textContent).toBe(line);
    await click(q('[data-testid="ssh-handoff-copy"]'));
    expect(written).toEqual([line]);
    await click(q('[data-testid="ssh-handoff-shell"]'));
    expect(fake.opened).toEqual([{ id: 'ssh-1', agent: 'shell' }]);
    fake.setupResult = { ok: true, alreadyCurrent: false, failure: null };
    expect(q('[data-testid="ssh-save"]')!.textContent).toBe('Try again');
    await click(q('[data-testid="ssh-save"]'));
    await settle(6);
    expect(fake.calls.map((c) => c.method)).toEqual(['check', 'add', 'setup', 'open', 'setup']);
    expect(q('[data-testid="add-device-sheet"]')).toBeNull();
  });

  it('saved machines show without opening the sheet, and nothing renders while the Labs switch is off', async () => {
    await act(async () => root.render(<DevicesPage api={new DevicesFake({ enabled: true })} ssh={new SshFake({ hosts: [BUILD_BOX] })} />));
    await settle(6);
    expect(q('[data-testid="ssh-host-ssh-1"]')!.textContent).toContain('Linux');
    await act(async () => root.render(<DevicesPage api={new DevicesFake({ enabled: false })} ssh={new SshFake({ hosts: [BUILD_BOX] })} />));
    await settle(6);
    expect(q('[data-testid="ssh-machines"]')).toBeNull();
  });
});
