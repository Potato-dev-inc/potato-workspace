// @vitest-environment jsdom
// The chat's own View menu (the header switch of every chat) carries the two chat-look switches that used to sit in
// Settings > Agents > Chat: "Jump marks beside the chat" and "Show if build and tests passed". Ticking one saves it
// on the same store Settings used, and Settings no longer lists either row.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ViewModeToggle } from './ViewModeToggle';
import { getMessageRail, setMessageRail } from '../../lib/messageRail';
import { getDoneCardOn } from '../../lib/done-card';
import { SECTIONS } from '../settings/catalog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

const pill = () => document.querySelector<HTMLButtonElement>('.ck-chat-mode-pill')!;
const check = (label: string) => [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((i) => i.closest('label')?.textContent?.includes(label));

async function openMenu() {
  await act(async () => pill().click());
}

beforeEach(() => {
  try {
    window.localStorage.clear();
  } catch {
    /* no storage */
  }
  setMessageRail(false);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<ViewModeToggle mode="summary" onChange={vi.fn()} />));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('Chat View menu carries the chat-look switches', () => {
  it('the menu shows the two switches under the three views', async () => {
    await openMenu();
    expect(document.querySelector('[role="group"][aria-label="Chat look"]')).not.toBeNull();
    expect(check('Jump marks beside the chat')).toBeTruthy();
    expect(check('Show if build and tests passed')).toBeTruthy();
  });

  it('ticking "Jump marks beside the chat" saves it on the same store Settings used', async () => {
    await openMenu();
    expect(check('Jump marks beside the chat')!.checked).toBe(false);
    await act(async () => check('Jump marks beside the chat')!.click());
    expect(getMessageRail()).toBe(true);
    expect(check('Jump marks beside the chat')!.checked).toBe(true);
  });

  it('"Show if build and tests passed" is on by default and unticking it saves off', async () => {
    await openMenu();
    expect(check('Show if build and tests passed')!.checked).toBe(getDoneCardOn());
    await act(async () => check('Show if build and tests passed')!.click());
    expect(getDoneCardOn()).toBe(false);
  });

  it('Settings no longer lists either switch', () => {
    const ids = SECTIONS.flatMap((s) => s.rows.map((r) => r.id));
    for (const id of ['message-rail', 'done-card', 'chat-view', 'hidden-agents']) expect(ids).not.toContain(id);
  });
});
