// @vitest-environment jsdom
// "Less motion" in Settings (lib/comfort) makes Potato use its still frame, like the system setting does.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COMFORT_DEFAULTS } from '../../lib/comfort/model';
import { setComfort } from '../../lib/comfort/store';
import { PotatoFace } from './PotatoFace';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  setComfort(COMFORT_DEFAULTS);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setComfort(COMFORT_DEFAULTS);
});

const src = () => host.querySelector('img')!.getAttribute('src');

describe('PotatoFace and Less motion', () => {
  it('shows the moving picture by default and the still one when Less motion is on', () => {
    act(() => root.render(<PotatoFace state="working" />));
    const moving = src();
    expect(host.querySelector('img')!.hasAttribute('data-still')).toBe(false);
    act(() => void setComfort({ lessMotion: true }));
    expect(src()).not.toBe(moving);
    expect(host.querySelector('img')!.hasAttribute('data-still')).toBe(true);
    expect(host.querySelector('picture > source')!.getAttribute('srcset')).toBe(src());
    act(() => void setComfort({ lessMotion: false }));
    expect(src()).toBe(moving);
  });
});
