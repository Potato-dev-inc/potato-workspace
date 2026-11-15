// @vitest-environment jsdom
// Screen level (phone): "from Ren's PC" under a message, "is typing" signals to the PC while the person types, the
// "took this back" line with Take over, and the phone telling the PC its own name.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeClient } from '../../lib/bridge-types';
import { useEnglish } from '../../i18n/test-utils';
import { TOLD_NAME_KEY, usePhoneName } from '../../hooks/usePhoneName';
import { AcpPhoneDock } from './AcpPhoneDock';
import { PhoneChatView } from './PhoneChatView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
useEnglish();

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const NAMES = { local: { name: "Ren's PC", kind: 'this_pc' }, 'phone-1': { name: 'OPPO Reno13', kind: 'phone' } };
const chat = (froms: (string | undefined)[]) => ({
  available: true,
  reason: null,
  source: 'acp',
  waitingFor: null,
  rev: 1,
  reset: false,
  items: froms.flatMap((from, i) => [
    { kind: 'user', id: `u${i + 1}`, at: null, text: `message ${i + 1}`, ...(from ? { from } : {}) },
    { kind: 'assistant', id: `a${i + 1}`, at: null, text: 'ok', model: null, finalAnswer: true },
    { kind: 'turnEnd', id: `end:${i + 1}`, at: null, outcome: 'completed', durationMs: 1000 },
  ]),
});
const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

describe('phone: sent from', () => {
  it('shows the device under each message once more than one device wrote', async () => {
    const bridge = { paneChat: vi.fn(async () => chat([undefined, 'phone-1'])), deviceNames: vi.fn(async () => NAMES), listPaneMessages: vi.fn(async () => []) } as unknown as BridgeClient;
    await act(async () => {
      root.render(<PhoneChatView bridge={bridge} paneId="p1" canWatch canType={false} />);
    });
    await settle();
    const lines = [...host.querySelectorAll('[data-testid="phone-sent-from"]')].map((n) => n.textContent);
    expect(lines).toEqual(["from Ren's PC", 'from OPPO Reno13']);
  });

  it('shows nothing when the PC has no names route (an older PC)', async () => {
    const bridge = { paneChat: vi.fn(async () => chat([undefined, 'phone-1'])), listPaneMessages: vi.fn(async () => []) } as unknown as BridgeClient;
    await act(async () => {
      root.render(<PhoneChatView bridge={bridge} paneId="p1" canWatch canType={false} />);
    });
    await settle();
    expect(host.querySelectorAll('[data-testid="phone-sent-from"]')).toHaveLength(0);
  });

  it('tells the PC the person is typing, not more than every 3 seconds', async () => {
    const acpTyping = vi.fn(async () => ({}));
    const bridge = { paneChat: vi.fn(async () => chat([])), acpTyping, listPaneMessages: vi.fn(async () => []) } as unknown as BridgeClient;
    await act(async () => {
      root.render(<PhoneChatView bridge={bridge} paneId="p1" canWatch canType />);
    });
    await settle();
    const box = host.querySelector('textarea') as HTMLTextAreaElement;
    const type = async (value: string) => {
      await act(async () => {
        const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
        set.call(box, value);
        box.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };
    await type('h');
    await type('he');
    await type('hel');
    expect(acpTyping).toHaveBeenCalledTimes(1);
    expect(acpTyping).toHaveBeenCalledWith('p1');
  });
});

describe('phone: the PC took this back', () => {
  const dock = (state: unknown, over: Partial<BridgeClient> = {}) =>
    ({ acpSession: vi.fn(async () => state), listQuestions: vi.fn(async () => []), pairMe: vi.fn(async () => ({ local: false, device_id: 'phone-1', caps: [] })), ...over }) as unknown as BridgeClient;
  const base = { phase: 'idle', closed: false, turnInFlight: false, stopping: false, permissions: [] };
  const tookBack = { driver: null, took_back: { by: 'local', by_name: "Ren's PC", from: 'phone-1' } };

  it('says who took it back and Take over asks the PC to give it back', async () => {
    const acpClaim = vi.fn(async () => ({}));
    const bridge = dock({ ...base, drive: tookBack }, { acpClaim });
    await act(async () => {
      root.render(<AcpPhoneDock bridge={bridge} paneId="p1" canAnswer canType labels={new Map()} />);
    });
    await settle();
    expect(host.querySelector('[data-testid="phone-took-back"]')?.textContent).toContain("Ren's PC took this back");
    await act(async () => {
      (host.querySelector('[data-testid="phone-took-back"] button') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(acpClaim).toHaveBeenCalledWith('p1');
  });

  it('a phone that may not type has no Take over button', async () => {
    const bridge = dock({ ...base, drive: tookBack }, { acpClaim: vi.fn() });
    await act(async () => {
      root.render(<AcpPhoneDock bridge={bridge} paneId="p1" canAnswer canType={false} labels={new Map()} />);
    });
    await settle();
    expect(host.querySelector('[data-testid="phone-took-back"] button')).toBeNull();
  });

  it('shows another device typing, but never this phone back to itself', async () => {
    const other = dock({ ...base, drive: { driver: { id: 'link:abc', name: "Ren's Mac", typing: true, typing_ms: 6000 } } });
    await act(async () => {
      root.render(<AcpPhoneDock bridge={other} paneId="p1" canAnswer canType labels={new Map()} />);
    });
    await settle();
    expect(host.querySelector('[data-testid="phone-drive-note"]')?.textContent).toContain("Ren's Mac is typing…");
    const own = dock({ ...base, drive: { driver: { id: 'phone-1', name: 'OPPO Reno13', typing: true, typing_ms: 6000 } } });
    await act(async () => {
      root.render(<AcpPhoneDock bridge={own} paneId="p2" canAnswer canType labels={new Map()} />);
    });
    await settle();
    expect(host.querySelector('[data-testid="phone-drive-note"]')).toBeNull();
  });
});

describe('phone: telling the PC its own name', () => {
  function Probe({ bridge }: { bridge: BridgeClient }) {
    usePhoneName(bridge);
    return null;
  }

  it('tells the PC once, and again only when the name changed', async () => {
    const tellName = vi.fn(async (_name: string) => ({}));
    await act(async () => {
      root.render(<Probe bridge={{ tellName } as unknown as BridgeClient} />);
    });
    await settle();
    expect(tellName).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(TOLD_NAME_KEY)).toBe(tellName.mock.calls[0]![0]);
    await act(async () => {
      root.render(<Probe bridge={{ tellName } as unknown as BridgeClient} />);
    });
    await settle();
    expect(tellName).toHaveBeenCalledTimes(1);
  });

  it('does not break an old PC that has no such route', async () => {
    await act(async () => {
      root.render(<Probe bridge={{} as unknown as BridgeClient} />);
    });
    await settle();
  });
});
