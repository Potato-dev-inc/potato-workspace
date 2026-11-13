// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { EmptyState } from './EmptyState';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render(node: React.ReactNode) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  act(() => createRoot(host).render(node));
  return host;
}

describe('EmptyState', () => {
  it('draws a title, one line, one button and at most three quiet "or" rows', () => {
    const go = vi.fn();
    const host = render(
      <EmptyState
        page
        title="Welcome"
        line="One line."
        action={{ label: 'Go', onClick: go }}
        alternatives={['a', 'b', 'c', 'd'].map((label) => ({ label, onClick: () => {} }))}
      />,
    );
    expect(host.querySelector('h1')!.textContent).toBe('Welcome');
    expect(host.querySelector('.ck-empty-line')!.textContent).toBe('One line.');
    expect(host.querySelectorAll('.ck-btn--primary')).toHaveLength(1);
    expect(host.querySelectorAll('.ck-empty-or li')).toHaveLength(3);
    act(() => host.querySelector<HTMLButtonElement>('.ck-btn--primary')!.click());
    expect(go).toHaveBeenCalledTimes(1);
  });

  it('is an h2 by default and a plain div in a menu', () => {
    expect(render(<EmptyState title="T" />).querySelector('h2')).not.toBeNull();
    expect(render(<EmptyState plain title="T" />).querySelector('h1, h2')).toBeNull();
  });

  it('shows the quiet Potato mark, except in a small menu', () => {
    const big = render(<EmptyState title="T" />).querySelector('svg[data-mark="potato"]');
    expect(big?.getAttribute('class')).toBe('ck-potato ck-potato--quiet');
    expect(big?.getAttribute('width')).toBe('28');
    expect(render(<EmptyState plain title="T" />).querySelector('svg')).toBeNull();
  });
});
