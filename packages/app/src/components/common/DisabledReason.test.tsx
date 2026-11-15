// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { DisabledReason } from './DisabledReason';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render(node: React.ReactNode) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  act(() => createRoot(host).render(node));
  return host;
}

describe('DisabledReason', () => {
  it('draws the reason as a visible muted line, not a tooltip', () => {
    const host = render(<DisabledReason reason="Write what the agent should do." />);
    const line = host.querySelector('[data-disabled-reason]') as HTMLElement;
    expect(line.tagName).toBe('P');
    expect(line.className).toContain('dis-reason');
    expect(line.textContent).toBe('Write what the agent should do.');
    expect(line.hasAttribute('title')).toBe(false);
  });

  it('draws nothing when there is no reason', () => {
    for (const reason of [null, undefined, '', false] as const) {
      const host = render(<DisabledReason reason={reason} />);
      expect(host.querySelector('[data-disabled-reason]')).toBeNull();
      expect(host.textContent).toBe('');
    }
  });

  it('can sit inside a button as a span, with its id kept', () => {
    const host = render(
      <button type="button">
        Pick
        <DisabledReason as="span" id="why-1" reason="Asleep. Last seen 14:02" />
      </button>,
    );
    const line = host.querySelector('#why-1') as HTMLElement;
    expect(line.tagName).toBe('SPAN');
    expect(line.textContent).toBe('Asleep. Last seen 14:02');
    expect(host.querySelector('button p')).toBeNull();
  });
});
