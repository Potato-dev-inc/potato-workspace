// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCard, supportText } from './ErrorCard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
let written: string[];
// Built from pieces so this file holds no real-looking personal folder.
const HOME = ['C:', 'Us' + 'ers', 'sam'].join('\\');
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  written = [];
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async (s: string) => void written.push(s)) } });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === text);

describe('ErrorCard', () => {
  it('has the same shape every time: What happened, What you can do, one main button', async () => {
    const onClick = vi.fn();
    await act(async () => root.render(<ErrorCard what="Claude stopped." can="Start it again." action={{ label: 'Start again', onClick }} />));
    const text = host.textContent ?? '';
    expect(text).toContain('What happened');
    expect(text).toContain('Claude stopped.');
    expect(text).toContain('What you can do');
    expect(text).toContain('Start it again.');
    expect(host.querySelectorAll('.err-main')).toHaveLength(1);
    await act(async () => button('Start again')!.click());
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('keeps details folded until asked, and shows them redacted', async () => {
    await act(async () => root.render(<ErrorCard what="x" can="y" details={`at ${HOME}\\app\\main.ts key sk-abcdef123456`} />));
    expect(host.querySelector('.err-details')).toBeNull();
    await act(async () => button('Show details')!.click());
    const details = host.querySelector('.err-details')!.textContent ?? '';
    expect(details).not.toContain('sam');
    expect(details).not.toContain('sk-abcdef123456');
    expect(button('Show details')).toBeUndefined();
    expect(button('Hide details')!.getAttribute('aria-expanded')).toBe('true');
  });

  it('has no Details button when there is nothing to fold', async () => {
    await act(async () => root.render(<ErrorCard what="x" can="y" />));
    expect(button('Show details')).toBeUndefined();
    expect(button('Copy for support')).toBeTruthy();
  });

  it('Copy for support copies the three parts with no personal path and no key', async () => {
    await act(async () => root.render(<ErrorCard who="Claude" what={`Failed in ${HOME}\\proj`} can="Try again." details="sk-abcdef123456" />));
    await act(async () => button('Copy for support')!.click());
    expect(written).toHaveLength(1);
    expect(written[0]).toContain('Agent: Claude');
    expect(written[0]).toContain('What happened:');
    expect(written[0]).toContain('What you can do: Try again.');
    expect(written[0]).not.toContain('sam');
    expect(written[0]).not.toContain('sk-abcdef123456');
    expect(button('Copied')).toBeTruthy();
  });

  it('supportText leaves out Details when there are none', () => {
    expect(supportText({ what: 'a', can: 'b' })).toBe('What happened: a\nWhat you can do: b');
  });

  it('is an alert for screen readers', async () => {
    await act(async () => root.render(<ErrorCard what="x" can="y" />));
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
  });
});
