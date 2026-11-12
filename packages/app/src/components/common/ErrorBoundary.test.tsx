// @vitest-environment jsdom
import { act, useState, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary, errorDetails } from './ErrorBoundary';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let flaky = true;
function Bomb(): ReactElement {
  if (flaky) throw new TypeError('Cannot read properties of null (reading x)');
  return <p>recovered</p>;
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  flaky = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('ErrorBoundary', () => {
  it('shows the calm card, never the raw error, and leaves a sibling pane working', () => {
    act(() =>
      root.render(
        <div>
          <ErrorBoundary where="Pane A">
            <Bomb />
          </ErrorBoundary>
          <ErrorBoundary where="Pane B">
            <p>sibling ok</p>
          </ErrorBoundary>
        </div>,
      ),
    );
    expect(host.textContent).toContain('Something went wrong here');
    expect(host.textContent).not.toContain('Cannot read properties');
    expect(host.textContent).toContain('sibling ok');
  });

  it('reports the error once with where it happened', () => {
    const onError = vi.fn();
    act(() =>
      root.render(
        <ErrorBoundary where="Settings page" onError={onError}>
          <Bomb />
        </ErrorBoundary>,
      ),
    );
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][1]).toBe('Settings page');
  });

  it('Try again renders the children again', () => {
    act(() =>
      root.render(
        <ErrorBoundary>
          <Bomb />
        </ErrorBoundary>,
      ),
    );
    flaky = false;
    const retry = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Try again')!;
    act(() => retry.click());
    expect(host.textContent).toBe('recovered');
  });

  it('clears by itself when a reset key changes', () => {
    function Wrap() {
      const [k, setK] = useState(1);
      return (
        <>
          <button id="next" onClick={() => setK(2)} />
          <ErrorBoundary resetKeys={[k]}>
            <Bomb />
          </ErrorBoundary>
        </>
      );
    }
    act(() => root.render(<Wrap />));
    expect(host.textContent).toContain('Something went wrong here');
    flaky = false;
    act(() => (host.querySelector('#next') as HTMLButtonElement).click());
    expect(host.textContent).toBe('recovered');
  });

  it('Copy details puts the full text on the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    act(() =>
      root.render(
        <ErrorBoundary where="Pane A">
          <Bomb />
        </ErrorBoundary>,
      ),
    );
    const copy = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Copy details')!;
    await act(async () => copy.click());
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0][0]).toContain('Where: Pane A');
    expect(writeText.mock.calls[0][0]).toContain('Cannot read properties');
  });

  it('errorDetails copes with non-Error throws', () => {
    expect(errorDetails('boom', 'x', '')).toContain('Message: boom');
    expect(errorDetails(null, 'x', '')).toContain('Message: null');
  });
});
