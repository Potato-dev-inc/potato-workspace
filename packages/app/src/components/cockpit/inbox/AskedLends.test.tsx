// @vitest-environment jsdom
// Inbox > Needs you: the lend request card is gone the moment Lend (or No) is pressed. The answer takes a few seconds to settle on the
// backend, and the card used to sit there, busy, for all of it. A failed answer brings the card back so the person can try again.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REQUEST_OWN, lendState } from '../../../dev/lend-fixtures';
import { createFakeLendApi } from '../../../dev/lend-fixtures';
import type { LendApi } from '../../../lib/lend';
import { AskedLends } from './AskedLends';

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

const api = (answer: LendApi['answer']): LendApi => ({ ...createFakeLendApi({ requests_in: [REQUEST_OWN] }), state: async () => lendState({ requests_in: [REQUEST_OWN] }), answer });
const card = () => host.querySelector('[data-asked-lend]:not([hidden])');
const press = (label: RegExp) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => label.test(b.textContent ?? ''))!;
async function mount(a: LendApi) {
  await act(async () => root.render(<AskedLends now={Date.now()} api={a} />));
  for (let i = 0; i < 5; i++) await act(async () => {});
}

describe('the lend request card in the Inbox', () => {
  it('leaves at once when the answer is pressed, while the answer is still on its way', async () => {
    let finish: () => void = () => undefined;
    await mount(api(() => new Promise((resolve) => (finish = () => resolve(null)))));
    expect(card()).not.toBeNull();
    await act(async () => press(/^Lend/).click());
    expect(card()).toBeNull();
    await act(async () => finish());
  });

  it('comes back when the answer fails (the person can try again)', async () => {
    const answer = vi.fn(async () => Promise.reject('That PC did not answer.'));
    await mount(api(answer));
    await act(async () => press(/^Lend/).click());
    for (let i = 0; i < 3; i++) await act(async () => {});
    expect(card()).not.toBeNull();
  });
});
