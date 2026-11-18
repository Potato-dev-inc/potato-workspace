// @vitest-environment jsdom
// "<PC> asks to work on this PC": the real card on the far PC behind "Ask <PC> to allow agents". It shows for a question that came
// before the window opened and for one that arrives later; Allow turns the switch on for that PC (the app command), Not now changes
// nothing; one card at a time; nothing is drawn when nobody asked.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DevicesFake, MAC_MINI, NODE_MAC, WORK_LAPTOP } from '../../dev/devices-fixtures';
import { settle, click } from '../settings/test-utils';
import { FullAskNotice } from './FullAskNotice';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

/** Holds the button down for `ms` (the card is rendered with a short hold in tests), or lets go at once. */
async function press(el: HTMLElement | null, ms: number) {
  const button = el!.closest('button')!;
  await act(async () => {
    button.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    await new Promise((r) => setTimeout(r, ms));
    button.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }));
  });
}
const HOLD = 30;
const q = (sel: string) => host.querySelector<HTMLElement>(sel);
const ask = (id: string, node: string, name: string) => ({ id, node, name, at_ms: 1 });
const fakeOf = () => new DevicesFake({ enabled: true, devices: [{ ...MAC_MINI, lets_run: true, level: 'answer' }, WORK_LAPTOP] });

describe('the "can work on this PC" card', () => {
  it('draws nothing when nobody asked', async () => {
    await act(async () => root.render(<FullAskNotice api={fakeOf()} />));
    await settle(4);
    expect(q('[data-testid="full-ask-notice"]')).toBeNull();
  });

  it('shows a question made before the window opened, with the PC named and what Allow means', async () => {
    const fake = fakeOf();
    fake.incomingAsks.push(ask('a1', NODE_MAC, 'Mac mini'));
    await act(async () => root.render(<FullAskNotice api={fake} holdMs={HOLD} />));
    await settle(4);
    const card = q('[data-testid="full-ask-notice"]')!;
    expect(card.textContent).toContain('Mac mini asks to work on this PC');
    expect(card.textContent).toContain('This lets Mac mini start agents, use the terminal and change files on this PC.');
    expect(card.getAttribute('role')).toBe('alertdialog');
  });

  it('Allow answers yes for that PC and the card goes; the switch is on for it in the app', async () => {
    const fake = fakeOf();
    await act(async () => root.render(<FullAskNotice api={fake} holdMs={HOLD} />));
    await settle(2);
    await act(async () => fake.simulateFullAsk(ask('a2', NODE_MAC, 'Mac mini')));
    await settle(2);
    expect(q('[data-testid="full-ask-notice"]')).not.toBeNull();
    // A click, or a hold that is let go early, grants nothing.
    await click(q('[data-testid="full-ask-allow"]'));
    await press(q('[data-testid="full-ask-allow"]'), 5);
    await settle(2);
    expect(fake.answeredAsks).toEqual([]);
    expect(q('[data-testid="full-ask-notice"]')).not.toBeNull();
    // Held for the whole time: allowed.
    await press(q('[data-testid="full-ask-allow"]'), HOLD * 4);
    await settle(4);
    expect(fake.answeredAsks).toEqual([{ id: 'a2', allow: true }]);
    expect(fake.view.devices.find((d) => d.node === NODE_MAC)!.level).toBe('full');
    expect(q('[data-testid="full-ask-notice"]')).toBeNull();
  });

  it('Not now answers no, grants nothing, and shows the next card behind it', async () => {
    const fake = fakeOf();
    await act(async () => root.render(<FullAskNotice api={fake} holdMs={HOLD} />));
    await settle(2);
    await act(async () => {
      fake.simulateFullAsk(ask('a3', NODE_MAC, 'Mac mini'));
      fake.simulateFullAsk(ask('a4', WORK_LAPTOP.node, 'Work laptop'));
    });
    await settle(2);
    expect(q('[data-testid="full-ask-notice"]')!.textContent).toContain('Mac mini asks');
    await click(q('[data-testid="full-ask-no"]'));
    await settle(4);
    expect(fake.answeredAsks).toEqual([{ id: 'a3', allow: false }]);
    expect(fake.view.devices.find((d) => d.node === NODE_MAC)!.level).toBe('answer');
    expect(q('[data-testid="full-ask-notice"]')!.textContent).toContain('Work laptop asks');
  });

  it('a long or odd name is clipped and shown as text only', async () => {
    const fake = fakeOf();
    fake.incomingAsks.push(ask('a5', NODE_MAC, `<b>x</b>${'y'.repeat(100)}`));
    await act(async () => root.render(<FullAskNotice api={fake} holdMs={HOLD} />));
    await settle(4);
    expect(q('[data-testid="full-ask-notice"] b')).toBeNull();
    expect(q('.ck-ctlask-title')!.textContent!.length).toBeLessThan(90);
  });
});
