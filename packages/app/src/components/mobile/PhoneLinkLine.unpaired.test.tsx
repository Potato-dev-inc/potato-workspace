// @vitest-environment jsdom
// A phone that was never paired says so, instead of blaming the PC for being asleep.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { PhoneLinkLine } from './PhoneLinkLine';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('PhoneLinkLine unpaired', () => {
  it('says "not paired yet" with a Pair button; a paired phone keeps the asleep words', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const pair = vi.fn();
    act(() => root.render(<PhoneLinkLine kind="asleep" recovered={false} unpaired onPairAgain={pair} />));
    expect(host.textContent).toContain("isn't paired yet");
    expect(host.textContent).not.toContain('asleep');
    act(() => host.querySelector('button')!.click());
    expect(pair).toHaveBeenCalled();
    act(() => root.render(<PhoneLinkLine kind="asleep" recovered={false} />));
    expect(host.textContent).toContain('asleep');
    act(() => root.unmount());
  });
});
