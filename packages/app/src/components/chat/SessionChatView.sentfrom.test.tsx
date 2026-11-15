// @vitest-environment jsdom
// Screen level (desktop): "from OPPO Reno13" under a message another device sent. Nothing shows while every message came
// from this PC; once another device wrote in the chat each message says where it came from; a rename shows at once.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEVICE_NAMES_CHANGED, type DeviceNameMap } from '../../lib/deviceNames';
import { groupTurns, type ChatItem } from '../../lib/sessionChat';
import { useEnglish } from '../../i18n/test-utils';
import { SessionChatView } from './SessionChatView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
useEnglish();

const mocks = vi.hoisted(() => ({ names: {} as DeviceNameMap }));
vi.mock('../../lib/deviceNames.desktop', () => ({ loadDesktopDeviceNames: async () => mocks.names }));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  mocks.names = { local: { name: "Ren's PC", kind: 'this_pc' }, 'phone-1': { name: 'OPPO Reno13', kind: 'phone' } };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const items = (froms: (string | undefined)[]): ChatItem[] =>
  froms.flatMap((from, i): ChatItem[] => [
    { kind: 'user', id: `u${i + 1}`, at: null, text: `message ${i + 1}`, ...(from ? { from } : {}) },
    { kind: 'assistant', id: `a${i + 1}`, at: null, text: 'ok', model: null, finalAnswer: true },
    { kind: 'turnEnd', id: `end:${i + 1}`, at: null, outcome: 'completed', durationMs: 1000 },
  ]);

async function show(froms: (string | undefined)[]) {
  await act(async () => {
    root.render(<SessionChatView state="ready" reason={null} source="acp" turns={groupTurns(items(froms)).turns} model={null} cliVersion={null} paneId="p1" />);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

const lines = () => [...host.querySelectorAll('[data-testid="sent-from"]')].map((n) => n.textContent);

describe('sent from, on the desktop chat', () => {
  it('says nothing while every message came from this PC', async () => {
    await show([undefined, undefined]);
    expect(lines()).toEqual([]);
  });

  it('marks every message once another device wrote in the chat, with that device name', async () => {
    await show([undefined, 'phone-1']);
    expect(lines()).toEqual(["from Ren's PC", 'from OPPO Reno13']);
  });

  it('shows a rename at once, also on the old messages', async () => {
    await show(['phone-1', undefined, 'phone-1']);
    expect(lines()).toEqual(['from OPPO Reno13', "from Ren's PC", 'from OPPO Reno13']);
    mocks.names = { ...mocks.names, 'phone-1': { name: "Ren's phone", kind: 'phone' } };
    await act(async () => {
      window.dispatchEvent(new Event(DEVICE_NAMES_CHANGED));
      await Promise.resolve();
    });
    expect(lines()).toEqual(["from Ren's phone", "from Ren's PC", "from Ren's phone"]);
  });

  it('says nothing for a device it has no name for (no guessing)', async () => {
    await show(['phone-9']);
    expect(lines()).toEqual([]);
  });
});
