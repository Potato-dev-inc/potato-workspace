// @vitest-environment jsdom
// Settings > Shortcuts: a row per shortcut, recording the next keys, conflict and terminal-key warnings that the
// person may override, Turn off, Reset, Reset all, and the OS refusing a global shortcut.
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BINDABLE, getKeybindings, setKeybindings } from '../../../lib/shortcuts';
import { byLabel, click, mountRows, settle, type Mounted } from '../test-utils';
import { shortcutsApi, shortcutsRows } from './ShortcutsSection';

let m: Mounted | null = null;
beforeEach(() => {
  vi.spyOn(shortcutsApi, 'globalSet').mockResolvedValue(undefined);
  vi.spyOn(shortcutsApi, 'globalStatus').mockResolvedValue([]);
});
afterEach(async () => {
  await m?.unmount();
  m = null;
  setKeybindings({});
  vi.restoreAllMocks();
});

const row = (id: string): HTMLElement => m!.host.querySelector<HTMLElement>(`[data-shortcut="${id}"]`)!;
const press = async (init: KeyboardEventInit & { key: string }) => {
  await act(async () => {
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  });
  await settle();
};
const buttonText = (root: ParentNode, text: string): HTMLButtonElement | undefined => [...root.querySelectorAll('button')].find((b) => b.textContent?.includes(text));

describe('Settings > Shortcuts', () => {
  it('has a row for every shortcut you can change, and a Reset all row', async () => {
    m = await mountRows(shortcutsRows);
    for (const entry of BINDABLE) expect(row(entry.id), entry.id).not.toBeNull();
    expect(m.host.textContent).toContain('Reset all shortcuts');
    expect(row('palette').textContent).toContain('Ctrl+K');
    expect(row('pane-jump').textContent).toContain('Alt+Shift+1–9');
  });

  it('every row has a plain hint of 90 characters or fewer', () => {
    for (const r of shortcutsRows) {
      expect(r.hint, r.id).toBeTruthy();
      expect(r.hint!.length, r.id).toBeLessThanOrEqual(90);
    }
  });

  it('Change listens for the next keys and saves them', async () => {
    m = await mountRows(shortcutsRows);
    await click(byLabel(row('palette'), 'Change keys for ' + BINDABLE.find((b) => b.id === 'palette')!.label));
    expect(row('palette').textContent).toContain('Press the keys');
    await press({ key: 'p', ctrlKey: true });
    expect(m.env.patches).toEqual([{ keybindings: { palette: 'Mod+P' } }]);
    expect(getKeybindings()).toEqual({ palette: 'Mod+P' });
  });

  it('Esc cancels and saves nothing', async () => {
    m = await mountRows(shortcutsRows);
    await click(buttonText(row('palette'), 'Change'));
    await press({ key: 'Escape' });
    expect(m.env.patches).toEqual([]);
    expect(row('palette').textContent).not.toContain('Press the keys');
    expect(row('palette').textContent).toContain('Ctrl+K');
  });

  it('waits while only a modifier is down', async () => {
    m = await mountRows(shortcutsRows);
    await click(buttonText(row('palette'), 'Change'));
    await press({ key: 'Control', ctrlKey: true });
    expect(row('palette').textContent).toContain('Press the keys');
    expect(m.env.patches).toEqual([]);
  });

  it('says why keys without Ctrl or Alt cannot be used', async () => {
    m = await mountRows(shortcutsRows);
    await click(buttonText(row('palette'), 'Change'));
    await press({ key: 'j' });
    expect(row('palette').querySelector('[role="alert"]')?.textContent).toMatch(/Ctrl, Alt/);
    expect(m.env.patches).toEqual([]);
  });

  it('warns when another shortcut has the keys, names it, and saves only after "Use it anyway"', async () => {
    m = await mountRows(shortcutsRows);
    await click(buttonText(row('palette'), 'Change'));
    await press({ key: 'n', ctrlKey: true });
    const alert = row('palette').querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('New agent');
    expect(m.env.patches).toEqual([]);
    await click(buttonText(row('palette'), 'anyway'));
    expect(m.env.patches).toEqual([{ keybindings: { palette: 'Mod+N' } }]);
  });

  it('warns about a terminal key, and "Pick another" listens again', async () => {
    m = await mountRows(shortcutsRows);
    await click(buttonText(row('palette'), 'Change'));
    await press({ key: 'd', ctrlKey: true });
    expect(row('palette').querySelector('[role="alert"]')?.textContent).toMatch(/Terminals use Ctrl\+D/);
    await click(buttonText(row('palette'), 'Pick another'));
    expect(row('palette').textContent).toContain('Press the keys');
    expect(m.env.patches).toEqual([]);
  });

  it('Turn off saves "none" and the row says Off', async () => {
    m = await mountRows(shortcutsRows);
    await click(buttonText(row('palette'), 'Turn off'));
    expect(m.env.patches).toEqual([{ keybindings: { palette: 'none' } }]);
    await m.rerender();
    expect(row('palette').textContent).toContain('Off');
    expect(buttonText(row('palette'), 'Turn off')).toBeUndefined();
  });

  it('Reset appears only for a changed shortcut and puts the default back', async () => {
    m = await mountRows(shortcutsRows, { settings: { ...(await import('../test-utils')).BASE_SETTINGS, keybindings: { palette: 'Mod+P' } } });
    expect(row('palette').textContent).toContain('Ctrl+P');
    expect(buttonText(row('split'), 'Reset')).toBeUndefined();
    await click(buttonText(row('palette'), 'Reset'));
    expect((m.env.patches[0].keybindings as unknown as Record<string, unknown>).palette).toBeNull();
  });

  it('keys equal to the default are stored as no choice at all', async () => {
    m = await mountRows(shortcutsRows, { settings: { ...(await import('../test-utils')).BASE_SETTINGS, keybindings: { palette: 'Mod+P' } } });
    await click(buttonText(row('palette'), 'Change'));
    await press({ key: 'k', ctrlKey: true });
    expect((m.env.patches[0].keybindings as unknown as Record<string, unknown>).palette).toBeNull();
  });

  it('Reset all asks first, then clears every choice', async () => {
    m = await mountRows(shortcutsRows, { settings: { ...(await import('../test-utils')).BASE_SETTINGS, keybindings: { palette: 'Mod+P', split: 'none' } } });
    m.env.confirm.mockResolvedValueOnce(false);
    await click(buttonText(m.host.querySelector('[data-row="shortcuts-reset-all"]')!, 'Reset all'));
    expect(m.env.patches).toEqual([]);
    await click(buttonText(m.host.querySelector('[data-row="shortcuts-reset-all"]')!, 'Reset all'));
    expect(m.env.patches).toEqual([{ keybindings: null }]);
  });

  it('a global shortcut goes to the OS first and is not saved when the OS refuses', async () => {
    vi.mocked(shortcutsApi.globalSet).mockRejectedValueOnce('Ctrl+Alt+K is already used by another app or by Windows. Pick another combination.');
    m = await mountRows(shortcutsRows);
    await click(buttonText(row('ask-bar'), 'Change'));
    await press({ key: 'k', ctrlKey: true, altKey: true });
    expect(shortcutsApi.globalSet).toHaveBeenCalledWith('ask-bar', 'Mod+Alt+K');
    expect(row('ask-bar').querySelector('[role="alert"]')?.textContent).toContain('already used by another app');
    expect(m.env.patches).toEqual([]);
  });

  it('a global shortcut the OS accepts is saved', async () => {
    m = await mountRows(shortcutsRows);
    await click(buttonText(row('stop-all'), 'Change'));
    await press({ key: 'k', ctrlKey: true, altKey: true });
    expect(shortcutsApi.globalSet).toHaveBeenCalledWith('stop-all', 'Mod+Alt+K');
    expect(m.env.patches).toEqual([{ keybindings: { 'stop-all': 'Mod+Alt+K' } }]);
  });

  it('shows the note Rust keeps when the choice was not the one in use', async () => {
    vi.mocked(shortcutsApi.globalStatus).mockResolvedValue([{ id: 'ask-bar', active: 'Mod+Alt+Space', note: 'Ctrl+Alt+K is used by another app, so the default is on.', switched_on: true }]);
    m = await mountRows(shortcutsRows);
    expect(row('ask-bar').textContent).toContain('used by another app');
  });
});
