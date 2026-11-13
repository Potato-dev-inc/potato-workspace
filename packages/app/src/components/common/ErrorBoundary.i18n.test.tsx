// @vitest-environment jsdom
// The fallback card of a crashed part, in Traditional Chinese. It is a function component inside the boundary, so it
// follows a language change while it is on screen.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChinese, useEnglish, visibleEnglish } from '../../i18n/test-utils';
import { setLanguagePref, t } from '../../i18n';
import { ErrorBoundary } from './ErrorBoundary';

vi.mock('../../lib/globalErrors', () => ({ reportUiError: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  useChinese();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  useEnglish();
  vi.restoreAllMocks();
});

function Broken(): never {
  throw new Error('boom');
}

describe('the crash card in Traditional Chinese', () => {
  it('says what happened in Chinese and offers the two buttons', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    act(() =>
      root.render(
        <ErrorBoundary where="Pane">
          <Broken />
        </ErrorBoundary>,
      ),
    );
    const card = host.querySelector('[role="alert"]')!;
    expect(card.textContent).toContain(t('common.errorTitle'));
    expect(Array.from(card.querySelectorAll('button')).map((b) => b.textContent)).toEqual([t('common.tryAgain'), t('common.copyDetails')]);
    expect(visibleEnglish(card)).toEqual([]);
  });

  it('follows a language change while it is on screen', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    act(() =>
      root.render(
        <ErrorBoundary where="Pane">
          <Broken />
        </ErrorBoundary>,
      ),
    );
    act(() => setLanguagePref('en', false));
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('Something went wrong here');
  });
});
