// @vitest-environment jsdom
// Settings > Danger zone: the Reset confirm lives in the page, the uninstall list starts with the founder's defaults
// (Keep my chats and Store programs unticked), the final button needs UNINSTALL typed, progress follows the events,
// and a dev build says so. The commands are a fake: nothing real is ever called.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UninstallApi, UninstallPlan, UninstallProgress } from '../../../lib/uninstall';
import { summaryLine } from '../../../lib/uninstall';
import { dangerRows, DangerZone, NOT_IN_DEV_TEXT, RESET_HINT, UNINSTALL_HINT } from './DangerZone';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const group = (id: string, title: string, over: Partial<UninstallPlan['groups'][number]> = {}): UninstallPlan['groups'][number] => ({
  id,
  title,
  detail: `${title} detail.`,
  size: '',
  bytes: 0,
  files: 0,
  connections: 0,
  defaultOn: true,
  keepReason: null,
  items: [],
  ...over,
});

const PLAN: UninstallPlan = {
  groups: [
    group('program', 'The program', { size: '412 MB', files: 1200, items: [{ label: 'C:\\Program Files\\Potato Workspace\\', path: null, bytes: 1, files: 1200 }] }),
    group('app_data', 'App data', { size: '1.3 GB', files: 1000 }),
    group('connections', 'Agent connections', { size: '9 entries', connections: 9, items: Array.from({ length: 12 }, (_, i) => ({ label: `entry ${i}`, path: null, bytes: 0, files: 0 })) }),
    group('chats', 'Your chats', { files: 114 }),
    group('unsaved_branches', 'Branches with unsaved work', { defaultOn: false, keepReason: 'They hold work that is not merged.' }),
    group('store_programs', 'Agent programs from the Agent Store', { defaultOn: false, keepReason: 'You may use them without Potato Workspace.' }),
  ],
  cant: [
    { title: 'The relay in your Cloudflare account', how: 'Delete the worker called pm-relay.' },
    { title: 'Branches already pushed to GitHub', how: 'Delete them on GitHub.' },
  ],
  profiles: ['com.potatodev.workspace'],
  totalFiles: 2314,
  connections: 9,
  keys: 0,
  chatsZipName: 'Potato Workspace chats 2026-11-11.zip',
  keepChatsDefault: false,
};

interface Fake extends UninstallApi {
  emit: (p: UninstallProgress) => void;
  runs: unknown[];
  resets: number;
  finish: () => void;
  fail: (message: string) => void;
}

function fakeApi(allowed = true): Fake {
  let listener: ((p: UninstallProgress) => void) | null = null;
  let resolveRun: (() => void) | null = null;
  let rejectRun: ((e: Error) => void) | null = null;
  const api: Fake = {
    runs: [],
    resets: 0,
    emit: (p) => listener?.(p),
    finish: () => resolveRun?.(),
    fail: (m) => rejectRun?.(new Error(m)),
    allowed: async () => ({ allowed, reason: allowed ? null : NOT_IN_DEV_TEXT }),
    plan: async () => PLAN,
    run: (selection) => {
      api.runs.push(selection);
      return new Promise<void>((res, rej) => {
        resolveRun = res;
        rejectRun = rej;
      });
    },
    onProgress: async (l) => {
      listener = l;
      return () => {
        listener = null;
      };
    },
    resetSettings: async () => {
      api.resets += 1;
    },
  };
  return api;
}

let host: HTMLDivElement;
let root: Root;

async function flush() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function mount(api: UninstallApi) {
  await act(async () => {
    root.render(<DangerZone api={api} />);
  });
  await flush();
}

const buttons = () => [...host.querySelectorAll<HTMLButtonElement>('button')];
const button = (text: string | RegExp) => {
  const found = buttons().find((b) => (typeof text === 'string' ? b.textContent === text : text.test(b.textContent ?? '')));
  if (!found) throw new Error(`no button ${String(text)} in: ${buttons().map((b) => b.textContent).join(' | ')}`);
  return found;
};
const box = (name: string) => host.querySelector<HTMLInputElement>(`input[type="checkbox"][aria-label="${name}"]`)!;

async function click(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await flush();
}

async function type(el: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  host = document.createElement('div');
  host.className = 'settings';
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('Reset settings', () => {
  it('asks inside the page (no browser dialog), and only then resets', async () => {
    const api = fakeApi();
    const confirmSpy = vi.spyOn(window, 'confirm');
    await mount(api);
    expect(host.textContent).toContain(RESET_HINT);
    await click(button('Reset…'));
    expect(host.textContent).toContain('Reset all settings now?');
    expect(api.resets).toBe(0);
    await click(button('Reset settings'));
    expect(api.resets).toBe(1);
    expect(host.textContent).toContain('Settings reset. Agents and chats kept.');
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('Cancel puts the question away without resetting', async () => {
    const api = fakeApi();
    await mount(api);
    await click(button('Reset…'));
    await click(button('Cancel'));
    expect(host.textContent).not.toContain('Reset all settings now?');
    expect(api.resets).toBe(0);
  });

  it('a failed reset says so', async () => {
    const api = fakeApi();
    api.resetSettings = async () => {
      throw new Error('disk is read-only');
    };
    await mount(api);
    await click(button('Reset…'));
    await click(button('Reset settings'));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('disk is read-only');
  });
});

describe('Uninstall everything', () => {
  async function toList(api: UninstallApi) {
    await mount(api);
    await click(button('Uninstall…'));
  }

  it('lists the groups with the founder defaults: Keep my chats unticked, Store programs unticked', async () => {
    await toList(fakeApi());
    expect(box('Keep my chats').checked).toBe(false);
    expect(box('Agent programs from the Agent Store').checked).toBe(false);
    expect(box('Branches with unsaved work').checked).toBe(false);
    expect(box('The program').checked).toBe(true);
    expect(box('Your chats').checked).toBe(true);
    expect(host.textContent).toContain('412 MB');
    expect(host.textContent).toContain("We can't remove these for you");
    expect(host.textContent).toContain('The relay in your Cloudflare account');
    // Long lists are cut with a count.
    expect(host.textContent).toContain('+ 4 more');
  });

  it('Keep my chats comes first, in plain words', async () => {
    await toList(fakeApi());
    const text = host.textContent ?? '';
    expect(text.indexOf('Keep my chats')).toBeLessThan(text.indexOf('The program'));
    expect(text).toContain('Saves your chats as one zip in Documents first.');
  });

  it('the final button stays disabled until UNINSTALL is typed', async () => {
    const api = fakeApi();
    await toList(api);
    await click(button('Next'));
    expect(host.textContent).toContain('Are you sure?');
    expect(host.textContent).toContain('Removes 2,314 files and 9 agent connections.');
    expect(host.textContent).toContain('Windows will ask you once to allow removing the program.');
    const go = button('Uninstall everything');
    expect(go.disabled).toBe(true);
    const input = host.querySelector<HTMLInputElement>('#st-un-type')!;
    await type(input, 'UNINSTAL');
    expect(button('Uninstall everything').disabled).toBe(true);
    await type(input, 'uninstall');
    expect(button('Uninstall everything').disabled).toBe(false);
    expect(api.runs).toHaveLength(0);
  });

  it('sends exactly what is ticked, with Keep my chats and without the unticked groups', async () => {
    const api = fakeApi();
    await toList(api);
    await click(box('Keep my chats'));
    await click(box('App data'));
    await click(button('Next'));
    expect(host.textContent).toContain('Your chats are saved to Documents first.');
    await type(host.querySelector<HTMLInputElement>('#st-un-type')!, 'UNINSTALL');
    await click(button('Uninstall everything'));
    expect(api.runs).toEqual([{ groups: ['program', 'connections', 'chats'], keepChats: true }]);
  });

  it('says what happens to chats when they are not kept', async () => {
    await toList(fakeApi());
    await click(button('Next'));
    expect(host.textContent).toContain('Your chats will be deleted.');
  });

  it('shows the live checklist from the events and the left-behind list when it is over', async () => {
    const api = fakeApi();
    await toList(api);
    await click(button('Next'));
    await type(host.querySelector<HTMLInputElement>('#st-un-type')!, 'UNINSTALL');
    await click(button('Uninstall everything'));
    expect(host.textContent).toContain('Removing Potato Workspace…');
    const ev = (index: number, label: string, state: UninstallProgress['state'], detail = ''): UninstallProgress => ({ step: `s${index}`, label, detail, state, index, total: 4 });
    await act(async () => api.emit(ev(0, 'Stopping agents and the app\'s helpers', 'running')));
    expect(host.querySelector('[data-state="running"]')?.textContent).toContain("Stopping agents and the app's helpers");
    await act(async () => api.emit(ev(0, 'Stopping agents and the app\'s helpers', 'done')));
    await act(async () => api.emit(ev(1, 'Backing up your agents\' settings', 'done', '4 files copied')));
    expect(host.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('50');
    expect(host.textContent).toContain('4 files copied');
    await act(async () => api.emit(ev(2, 'Removing saved keys', 'done')));
    await act(async () => api.emit(ev(3, 'Deleting app data and the program', 'done')));
    await act(async () => api.finish());
    await flush();
    expect(host.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('100');
    expect(host.textContent).toContain('Potato Workspace is gone');
    expect(host.textContent).toContain("A few things we can't remove for you");
    expect(host.textContent).toContain('Delete the worker called pm-relay.');
  });

  it('a stopped run says why and offers Close', async () => {
    const api = fakeApi();
    await toList(api);
    await click(button('Next'));
    await type(host.querySelector<HTMLInputElement>('#st-un-type')!, 'UNINSTALL');
    await click(button('Uninstall everything'));
    await act(async () => api.fail('Nothing was removed. The chats zip came out empty'));
    await flush();
    expect(host.textContent).toContain('Nothing was removed.');
    expect(host.textContent).not.toContain('Potato Workspace is gone');
    expect(button('Close')).toBeTruthy();
  });

  it('in a dev build the button says so, is disabled, and nothing runs', async () => {
    const api = fakeApi(false);
    await mount(api);
    expect(host.textContent).toContain(NOT_IN_DEV_TEXT);
    await click(button('Uninstall…'));
    await click(button('Next'));
    await type(host.querySelector<HTMLInputElement>('#st-un-type')!, 'UNINSTALL');
    const go = button(NOT_IN_DEV_TEXT);
    expect(go.disabled).toBe(true);
    await click(go);
    expect(api.runs).toHaveLength(0);
  });

  it('Back and Cancel leave nothing started', async () => {
    const api = fakeApi();
    await toList(api);
    await click(button('Next'));
    await click(button('Back'));
    expect(host.textContent).toContain('Here is everything we found.');
    await click(button('Cancel'));
    expect(host.textContent).not.toContain('Here is everything we found.');
    expect(api.runs).toHaveLength(0);
  });
});

describe('rows and summary', () => {
  it('exports the two rows with the agreed ids and short hints', () => {
    expect(dangerRows.map((r) => r.id)).toEqual(['reset-settings', 'uninstall-everything']);
    for (const row of dangerRows) {
      expect(row.hint!.length).toBeLessThanOrEqual(90);
      expect(row.danger).toBe(true);
    }
    expect(dangerRows[0]!.hint).toBe('Put every setting back. Your agents and chats stay.');
    expect(dangerRows[1]!.hint).toBe(UNINSTALL_HINT);
  });

  it('the summary counts only what is ticked', () => {
    expect(summaryLine(PLAN, { groups: ['program', 'connections'], keepChats: false })).toBe('Removes 1,200 files and 9 agent connections.');
    expect(summaryLine(PLAN, { groups: ['connections'], keepChats: false })).toBe('Removes 9 agent connections.');
    expect(summaryLine(PLAN, { groups: [], keepChats: false })).toBe('Removes what you ticked.');
  });
});
