// @vitest-environment jsdom
// An output whose file tab said "That file is not there any more." is struck through with Remove, not listed as if it were there.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { useEnglish } from '../../../i18n/test-utils';
import { markGone } from '../../../lib/gone-files';
import { resetRailFoldForTests } from './railFold';
import { OutputsSection } from './OutputsSection';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const outputs = [
  { path: 'D:/p/a.md', tool: 'Write', wrote: true },
  { path: 'D:/p/b.txt', tool: 'Write', wrote: true },
];

describe('OutputsSection with a file that is gone', () => {
  beforeEach(() => {
    useEnglish();
    window.localStorage.clear();
    resetRailFoldForTests();
  });
  it('strikes it through, offers Remove, and Remove takes it off the list', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root: Root = createRoot(host);
    await act(async () => root.render(<OutputsSection paneId="pg" cwd="D:/p" outputs={outputs} />));
    expect(host.textContent).toContain('b.txt');
    await act(async () => markGone('pg', 'b.txt', true));
    const struck = [...host.querySelectorAll<HTMLElement>('.rp-name')].find((e) => e.textContent === 'b.txt');
    expect(struck?.style.textDecoration).toBe('line-through');
    expect(host.textContent).toContain('Gone from disk');
    await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Remove')!.click());
    expect(host.textContent).not.toContain('b.txt');
    expect(host.textContent).toContain('a.md');
    await act(async () => root.unmount());
  });
});
