// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { click, settle } from '../settings/test-utils';
import { JoinAccountSheet } from './JoinAccountSheet';

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
});

const q = (sel: string) => document.querySelector<HTMLElement>(sel);

async function mount(approve: (code: string, allow: boolean) => Promise<void>, onDone: (a: string) => void) {
  await act(async () => root.render(<JoinAccountSheet name="Build box" code="4821-7730" api={{ approveDevice: approve }} onDone={onDone} />));
  await settle(2);
}

describe('Add <machine> to your account?', () => {
  it('shows the machine and its code, and Add answers yes with that code', async () => {
    const calls: [string, boolean][] = [];
    const done: string[] = [];
    await mount(async (c, a) => void calls.push([c, a]), (a) => done.push(a));
    expect(document.body.textContent).toContain('Add Build box to your account?');
    expect(q('[data-testid="join-code"]')!.textContent).toBe('4821-7730');
    await click(q('[data-testid="join-add"]'));
    await settle(3);
    expect(calls).toEqual([['4821-7730', true]]);
    expect(done).toEqual(['added']);
  });

  it('Not me answers no', async () => {
    const calls: [string, boolean][] = [];
    const done: string[] = [];
    await mount(async (c, a) => void calls.push([c, a]), (a) => done.push(a));
    await click(q('[data-testid="join-refuse"]'));
    await settle(3);
    expect(calls).toEqual([['4821-7730', false]]);
    expect(done).toEqual(['refused']);
  });

  it('a refused answer from the server is said plainly and the sheet stays', async () => {
    const done: string[] = [];
    await mount(async () => Promise.reject(new Error('That code did not match.')), (a) => done.push(a));
    await click(q('[data-testid="join-add"]'));
    await settle(3);
    expect(q('[role="alert"]')!.textContent).toContain('That code did not match.');
    expect(done).toEqual([]);
  });
});
