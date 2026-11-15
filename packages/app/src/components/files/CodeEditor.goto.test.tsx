// @vitest-environment jsdom
// The code view opened at a line (a hit of "Search inside files"): the line is marked and the cursor is on it.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EditorView } from '@codemirror/view';
import { CodeEditor } from './CodeEditor';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);

const TEXT = ['one', 'two', 'three', 'four', 'five'].join('\n');
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const view = () => EditorView.findFromDOM(host.querySelector('.cm-editor') as HTMLElement)!;
const markedLines = () => [...host.querySelectorAll('.cm-hit-line')].map((l) => l.textContent);

describe('the code view at a line', () => {
  it('marks the line and puts the cursor on it', async () => {
    await act(async () => root.render(<CodeEditor path="a.txt" text={TEXT} goTo={{ line: 3, nonce: 1 }} />));
    expect(markedLines()).toEqual(['three']);
    const v = view();
    expect(v.state.doc.lineAt(v.state.selection.main.head).number).toBe(3);
  });

  it('moves the mark when asked for another line, and a line past the end goes to the last line', async () => {
    await act(async () => root.render(<CodeEditor path="a.txt" text={TEXT} goTo={{ line: 2, nonce: 1 }} />));
    expect(markedLines()).toEqual(['two']);
    await act(async () => root.render(<CodeEditor path="a.txt" text={TEXT} goTo={{ line: 99, nonce: 2 }} />));
    expect(markedLines()).toEqual(['five']);
  });

  it('marks nothing when there is no line to go to', async () => {
    await act(async () => root.render(<CodeEditor path="a.txt" text={TEXT} />));
    expect(markedLines()).toEqual([]);
  });
});
