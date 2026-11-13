// @vitest-environment jsdom
// Comfort on the page: the zoom keys, the root variable and the switches as attributes, and that a change
// reaches a screen that is already open.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyComfortToRoot, useComfortRoot, zoomKeyAction } from './root';
import { COMFORT_DEFAULTS } from './model';
import { getComfort, setComfort } from './store';

const key = (init: Partial<KeyboardEventInit> & { code: string }) => ({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...init });

function Host() {
  useComfortRoot();
  return null;
}

describe('zoom keys', () => {
  it('Ctrl+= makes it bigger, Ctrl+- smaller, and Ctrl+Shift+0 resets (plain Ctrl+0 is left alone)', () => {
    expect(zoomKeyAction(key({ code: 'Equal', ctrlKey: true }))).toBe('bigger');
    expect(zoomKeyAction(key({ code: 'NumpadAdd', ctrlKey: true }))).toBe('bigger');
    expect(zoomKeyAction(key({ code: 'Minus', ctrlKey: true }))).toBe('smaller');
    expect(zoomKeyAction(key({ code: 'Digit0', ctrlKey: true, shiftKey: true }))).toBe('reset');
    expect(zoomKeyAction(key({ code: 'Digit0', ctrlKey: true }))).toBeNull();
  });

  it('a plain key, or Alt with Ctrl, does nothing; Cmd works on a Mac', () => {
    expect(zoomKeyAction(key({ code: 'Equal' }))).toBeNull();
    expect(zoomKeyAction(key({ code: 'Equal', ctrlKey: true, altKey: true }))).toBeNull();
    expect(zoomKeyAction(key({ code: 'Equal', metaKey: true }))).toBe('bigger');
  });
});

describe('the page', () => {
  it('puts the scale on the root and the switches as attributes', () => {
    const root = document.createElement('html');
    applyComfortToRoot(root, { ...COMFORT_DEFAULTS, textScale: 130, strongContrast: true }, false);
    expect(root.style.getPropertyValue('--ui-scale')).toBe('1.3');
    expect(root.dataset.contrast).toBe('strong');
    expect(root.dataset.motion).toBe('normal');
  });

  it('less motion is on when the system asks for reduced motion', () => {
    const root = document.createElement('html');
    applyComfortToRoot(root, COMFORT_DEFAULTS, true);
    expect(root.dataset.motion).toBe('less');
  });
});

describe('the zoom keys on a live window', () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(async () => {
    setComfort(COMFORT_DEFAULTS);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root.render(<Host />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    setComfort(COMFORT_DEFAULTS);
  });

  it('Ctrl+= moves the size up one step and Ctrl+Shift+0 resets it', async () => {
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Equal', ctrlKey: true, key: '=' }));
    });
    expect(getComfort().textScale).toBe(110);
    expect(document.documentElement.style.getPropertyValue('--ui-scale')).toBe('1.1');
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit0', ctrlKey: true, shiftKey: true, key: ')' }));
    });
    expect(getComfort().textScale).toBe(100);
  });
});
