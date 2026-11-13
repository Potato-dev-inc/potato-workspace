// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pushComposerInsert, resetComposerInserts, takeComposerInserts } from './composer-insert';
import { useComposerDraft } from './composerDraft';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Probe({ paneId }: { paneId: string }) {
  const draft = useComposerDraft(paneId);
  return <output data-testid="draft">{draft ? draft.text : ''}</output>;
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  resetComposerInserts();
  window.localStorage.clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const shown = () => host.querySelector('[data-testid="draft"]')?.textContent;

describe('composer inserts', () => {
  it('joins what waits for a pane, once', () => {
    pushComposerInsert('p', 'one');
    pushComposerInsert('p', 'two');
    pushComposerInsert('other', 'x');
    pushComposerInsert('p', '   ');
    expect(takeComposerInserts('p')).toBe('one\n\ntwo');
    expect(takeComposerInserts('p')).toBeNull();
  });

  it('reaches the pane message box that is on screen', async () => {
    await act(async () => root.render(<Probe paneId="p" />));
    expect(shown()).toBe('');
    await act(async () => pushComposerInsert('p', 'look at this'));
    expect(shown()).toBe('look at this');
  });

  it('waits for a message box that opens later, and never reaches another pane', async () => {
    pushComposerInsert('p', 'for p');
    await act(async () => root.render(<Probe paneId="q" />));
    expect(shown()).toBe('');
    await act(async () => root.render(<Probe paneId="p" />));
    expect(shown()).toBe('for p');
  });
});
