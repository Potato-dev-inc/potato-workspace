// @vitest-environment jsdom
// Devices > Files, through the real parents: Settings > Devices > a device > Files tab; a remote chat > Open folder; a
// remote chat with a `potato-result:` line > Get it. Only the devices command layer is the fake (`DevicesFake`) and the
// folder dialog is mocked. Proves: browse, breadcrumb, select, Copy -> a transfer goes running -> done; the "already there"
// question (Replace is never sent without a click); a far error shows as plain text; text and picture previews; the
// switch and folder list on the device page; Open folder starts at the chat's folder; Get it.
import { open } from '@tauri-apps/plugin-dialog';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevicesFake, MAC_FILES, MAC_MINI, MAC_PANES, NODE_MAC, type DevicesScenario } from '../../dev/devices-fixtures';
import { click, settle } from '../settings/test-utils';
import { DevicesPage } from './DevicesPage';
import { RemotePaneView } from './RemotePaneView';

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('../../lib/tauri', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../lib/tauri')>();
  return { ...orig, tauri: { ...orig.tauri, listPairedMobileDevices: vi.fn(async () => []) } };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView = () => {};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  vi.mocked(open).mockReset();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = '';
});

const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const text = (sel: string) => q(sel)?.textContent ?? '';

const scenario = (patch: Partial<DevicesScenario> = {}): DevicesScenario => ({ enabled: true, devices: [{ ...MAC_MINI }], panes: { [NODE_MAC]: MAC_PANES }, files: MAC_FILES, ...patch });

async function openFilesTab(fake: DevicesFake) {
  await act(async () => root.render(<DevicesPage api={fake} />));
  await settle(6);
  await click(q(`[data-testid="device-${NODE_MAC}"]`));
  await click(q('[data-testid="device-tab-files"]'));
  await settle(8);
}

describe('Files tab of a device', () => {
  it('browses, goes up by the breadcrumb, selects, copies, and shows the transfer going running -> done', async () => {
    const fake = new DevicesFake(scenario());
    await openFilesTab(fake);
    // The first shared folder, folders before files, sizes in plain units.
    const rows = [...document.querySelectorAll('[data-testid^="file-row-"]')].map((r) => r.getAttribute('data-testid'));
    expect(rows).toEqual(['file-row-src', 'file-row-README.md', 'file-row-logo.png', 'file-row-build.dmg']);
    expect(text('[data-testid="file-row-build.dmg"]')).toContain('48 MB');
    await click(q('[data-testid="file-open-src"]'));
    await settle(4);
    expect(text('[data-testid="files-crumbs"]')).toContain('app');
    expect(text('[data-testid="files-crumbs"]')).toContain('src');
    expect(q('[data-testid="file-row-main.rs"]')).not.toBeNull();
    await click(q('[data-testid="file-pick-main.rs"]'));
    await click(q('[data-testid="files-copy"]'));
    await settle(6);
    const call = fake.fileCalls.find((c) => c.cmd === 'filesCopy')!;
    expect(call.args).toMatchObject({ node: NODE_MAC, root: 'app', paths: ['src/main.rs'], on_exists: 'ask' });
    expect(q('[data-testid="transfer-1"]')!.getAttribute('data-state')).toBe('running');
    expect(text('[data-testid="transfer-1"]')).toContain('0 of 48 MB');
    await act(async () => fake.progress(1, { bytes: 12_000_000 }));
    expect(text('[data-testid="transfer-1"]')).toContain('12 of 48 MB');
    await act(async () => fake.progress(1, { bytes: 48_000_000, state: 'done', saved_as: 'main.rs' }));
    await settle(2);
    expect(q('[data-testid="transfer-1"]')!.getAttribute('data-state')).toBe('done');
    expect(text('[data-testid="transfer-saved"]')).toBe('Saved to Downloads as main.rs');
    // The breadcrumb goes back up.
    await click(q('[data-testid="files-crumbs"] button'));
    await settle(4);
    expect(q('[data-testid="file-row-README.md"]')).not.toBeNull();
    // Clear finished removes the done row.
    await click(q('[data-testid="transfers-clear"]'));
    await settle(4);
    expect(q('[data-testid="transfer-1"]')).toBeNull();
  });

  it('asks before touching a name that is already there: Replace is never sent without a click', async () => {
    const fake = new DevicesFake(scenario({ files: { ...MAC_FILES, existing: ['build.dmg'] } }));
    await openFilesTab(fake);
    await click(q('[data-testid="file-pick-build.dmg"]'));
    await click(q('[data-testid="files-copy"]'));
    await settle(6);
    expect(text('[data-testid="exists-question"]')).toContain('A file named build.dmg is already there.');
    expect(fake.view.transfers).toHaveLength(0);
    await click(q('[data-testid="exists-both"]'));
    await settle(6);
    const copies = fake.fileCalls.filter((c) => c.cmd === 'filesCopy').map((c) => c.args.on_exists);
    expect(copies).toEqual(['ask', 'both']);
    expect(q('[data-testid="exists-question"]')).toBeNull();
    expect(q('[data-testid="transfer-1"]')).not.toBeNull();
  });

  it('Cancel on the question starts nothing and never sends replace', async () => {
    const fake = new DevicesFake(scenario({ files: { ...MAC_FILES, existing: ['build.dmg'] } }));
    await openFilesTab(fake);
    await click(q('[data-testid="file-pick-build.dmg"]'));
    await click(q('[data-testid="files-copy"]'));
    await settle(6);
    await click(q('[data-testid="exists-cancel"]'));
    await settle(2);
    expect(q('[data-testid="exists-question"]')).toBeNull();
    expect(fake.fileCalls.filter((c) => c.cmd === 'filesCopy')).toHaveLength(1);
    expect(fake.view.transfers).toHaveLength(0);
  });

  it('sends a file of this PC into the folder you are in', async () => {
    const fake = new DevicesFake(scenario());
    await openFilesTab(fake);
    await click(q('[data-testid="file-open-src"]'));
    await settle(4);
    vi.mocked(open).mockResolvedValueOnce(['C:\\Users\\me\\notes.txt']);
    await click(q('[data-testid="files-send"]'));
    await settle(6);
    const call = fake.fileCalls.find((c) => c.cmd === 'filesSend')!;
    expect(call.args).toMatchObject({ node: NODE_MAC, root: 'app', dir: 'src', local: ['C:\\Users\\me\\notes.txt'], on_exists: 'ask' });
    expect(vi.mocked(open)).toHaveBeenCalledWith({ multiple: true, directory: false });
    expect(text('[data-testid="transfer-1"]')).toContain('notes.txt');
    // The second button picks a folder.
    vi.mocked(open).mockResolvedValueOnce(['C:\\Users\\me\\pics']);
    await click(q('[data-testid="files-send-folder"]'));
    await settle(4);
    expect(vi.mocked(open)).toHaveBeenLastCalledWith({ multiple: true, directory: true });
  });

  it('shows the far answer as plain text, never as markup', async () => {
    const words = 'That folder is not shared on this device.';
    const fake = new DevicesFake(scenario({ files: { ...MAC_FILES, farError: words } }));
    await openFilesTab(fake);
    expect(text('[data-testid="files-error"]')).toBe(words);
    expect(q('[data-testid="files-table"]')).toBeNull();
    await act(async () => root.unmount());
    root = createRoot(host);
    const rude = new DevicesFake(scenario({ files: { ...MAC_FILES, farError: '<img src=x onerror=alert(1)>Nope' } }));
    await openFilesTab(rude);
    expect(text('[data-testid="files-error"]')).toBe('<img src=x onerror=alert(1)>Nope');
    expect(q('[data-testid="files-error"] img')).toBeNull();
  });

  it('a list that the far device refuses (not shared) shows its words', async () => {
    const fake = new DevicesFake(scenario({ files: { tree: { app: {} } } }));
    await openFilesTab(fake);
    expect(text('[data-testid="files-error"]')).toBe('That folder is not shared on this device.');
  });

  it('previews text and a picture, says "No preview" for the rest, and copies the previewed file', async () => {
    const fake = new DevicesFake(scenario());
    await openFilesTab(fake);
    await click(q('[data-testid="file-open-README.md"]'));
    await settle(4);
    expect(text('[data-testid="preview-text"]')).toContain('A small app. Run it with make.');
    await click(q('[data-testid="file-open-logo.png"]'));
    await settle(4);
    expect(q<HTMLImageElement>('[data-testid="preview-image"]')!.getAttribute('src')!.startsWith('data:image/png;base64,iVBOR')).toBe(true);
    await click(q('[data-testid="file-open-build.dmg"]'));
    await settle(4);
    expect(text('[data-testid="preview-none"]')).toContain('48 MB');
    // With one file previewed and nothing ticked, Copy takes the previewed file.
    await click(q('[data-testid="files-copy"]'));
    await settle(6);
    expect(fake.fileCalls.find((c) => c.cmd === 'filesCopy')!.args.paths).toEqual(['build.dmg']);
  });
});

describe('the device page', () => {
  it('has the files switch off at first, then the folder list with Add and Remove', async () => {
    const fake = new DevicesFake(scenario());
    await act(async () => root.render(<DevicesPage api={fake} />));
    await settle(6);
    await click(q(`[data-testid="device-${NODE_MAC}"]`));
    expect(q<HTMLInputElement>('[data-testid="perm-files"]')!.checked).toBe(false);
    expect(text('[data-testid="device-page"]')).toContain('Browse and copy files');
    expect(q('[data-testid="device-folders"]')).toBeNull();
    await click(q('[data-testid="perm-files"]'));
    await settle(6);
    expect(fake.view.devices[0]!.lets_files).toBe(true);
    expect(text('[data-testid="device-folders"]')).toContain('By default only your project folders are shared.');
    expect([...document.querySelectorAll('[data-testid="folder-shared"]')].map((e) => e.textContent)).toEqual(['app', 'notes']);
    vi.mocked(open).mockResolvedValueOnce('C:\\Users\\me\\Pictures');
    await click(q('[data-testid="folder-add"]'));
    await settle(6);
    expect(vi.mocked(open)).toHaveBeenCalledWith({ directory: true, multiple: false });
    expect(fake.fileCalls.filter((c) => c.cmd === 'setFilesFolders').at(-1)!.args.folders).toEqual(['C:\\Users\\me\\Pictures']);
    expect(text('[data-testid="folder-chosen"]')).toContain('C:\\Users\\me\\Pictures');
    await click(q('[data-testid="folder-remove"]'));
    await settle(6);
    expect(q('[data-testid="folder-chosen"]')).toBeNull();
    expect(fake.fileCalls.filter((c) => c.cmd === 'setFilesFolders').at(-1)!.args.folders).toEqual([]);
    // Turning it off hides the list again.
    await click(q('[data-testid="perm-files"]'));
    await settle(6);
    expect(fake.view.devices[0]!.lets_files).toBe(false);
    expect(q('[data-testid="device-folders"]')).toBeNull();
  });

  it('shows the transfers on the Overview tab too', async () => {
    const fake = new DevicesFake(scenario({ transfers: [{ id: 5, node: NODE_MAC, dir: 'up', name: 'plan.pdf', bytes: 1_000_000, total: 4_000_000, state: 'running', error: '', saved_as: '' }] }));
    await act(async () => root.render(<DevicesPage api={fake} />));
    await settle(6);
    await click(q(`[data-testid="device-${NODE_MAC}"]`));
    await settle(4);
    expect(text('[data-testid="transfer-5"]')).toContain('plan.pdf');
    expect(text('[data-testid="transfer-5"]')).toContain('1 of 4 MB');
    await click(q('[data-testid="transfer-stop"]'));
    await settle(4);
    expect(q('[data-testid="transfer-5"]')!.getAttribute('data-state')).toBe('stopped');
  });
});

describe('from a remote chat', () => {
  const chatRow = { paneId: 'p1', chat: true, title: 'Build the .dmg', agent: 'claude', cwd: '/Users/me/app' };
  const mountRemote = async (fake: DevicesFake) => {
    await act(async () => root.render(<RemotePaneView device={fake.view.devices[0]!} row={chatRow} api={fake} />));
    await settle(8);
  };

  it('Open folder replaces the chat with Files, starts at the chat folder, and Back returns', async () => {
    const fake = new DevicesFake(scenario({ files: { ...MAC_FILES, tree: { notes: MAC_FILES.tree.notes!, app: MAC_FILES.tree.app! } } }));
    await mountRemote(fake);
    expect(q('[data-testid="open-remote-folder"]')!.getAttribute('title')).toBe('Open folder on Mac mini');
    await click(q('[data-testid="open-remote-folder"]'));
    await settle(8);
    expect(q('[data-testid="files-view"]')).not.toBeNull();
    // "notes" is the first root, but the chat's folder is "app".
    expect(q<HTMLSelectElement>('[data-testid="files-root"]')!.value).toBe('app');
    expect(q('[data-testid="file-row-README.md"]')).not.toBeNull();
    await click(q('[data-testid="files-back"]'));
    await settle(4);
    expect(q('[data-testid="files-view"]')).toBeNull();
    expect(q('[data-testid="open-remote-folder"]')).not.toBeNull();
  });

  const result = (line: string) => [{ kind: 'assistant', id: 'a1', at: 1, text: `The build is done.\n${line}`, model: null, finalAnswer: true }];

  it('offers Get it when the last reply names a result file, copies it, and says where it was saved', async () => {
    const fake = new DevicesFake(scenario({ chats: { p1: result('potato-result: build/app.dmg') } }));
    await mountRemote(fake);
    expect(text('[data-testid="get-it-card"]')).toContain('Mac mini has a file for you: app.dmg');
    await click(q('[data-testid="get-it"]'));
    await settle(6);
    const call = fake.fileCalls.find((c) => c.cmd === 'filesCopy')!;
    expect(call.args).toMatchObject({ node: NODE_MAC, root: 'app', paths: ['build/app.dmg'], on_exists: 'ask' });
    expect(q('[data-testid="get-it-card"] [data-testid="transfer-1"]')!.getAttribute('data-state')).toBe('running');
    await act(async () => fake.progress(1, { bytes: 48_000_000, state: 'done' }));
    await settle(2);
    expect(text('[data-testid="get-it-card"]')).toContain('Saved to Downloads as app.dmg');
  });

  it('Get it uses the same question when the name is taken', async () => {
    const fake = new DevicesFake(scenario({ chats: { p1: result('potato-result: build/app.dmg') }, files: { ...MAC_FILES, existing: ['app.dmg'] } }));
    await mountRemote(fake);
    await click(q('[data-testid="get-it"]'));
    await settle(6);
    expect(text('[data-testid="get-it-card"]')).toContain('A file named app.dmg is already there.');
    await click(q('[data-testid="exists-both"]'));
    await settle(6);
    expect(fake.fileCalls.filter((c) => c.cmd === 'filesCopy').map((c) => c.args.on_exists)).toEqual(['ask', 'both']);
    expect(q('[data-testid="get-it-card"] [data-testid="transfer-1"]')).not.toBeNull();
  });

  it('shows no card for an unsafe result path', async () => {
    const fake = new DevicesFake(scenario({ chats: { p1: result('potato-result: ../secrets.txt') } }));
    await mountRemote(fake);
    expect(q('[data-testid="get-it-card"]')).toBeNull();
  });
});
