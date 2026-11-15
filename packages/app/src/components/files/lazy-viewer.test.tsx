// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileTab } from './FileTab';
import { fakeApi } from './fakes';
import { PDF_SAMPLE } from './office-fixtures';
import { useEnglish } from '../../i18n/test-utils';
import type { FileBytes } from '../../lib/files-api';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The PDF viewer chunk cannot load in this file: the screen must stay up and offer the file's own app.
const loads = vi.hoisted(() => ({ count: 0 }));
vi.mock('./PdfView', () => {
  loads.count += 1;
  throw new Error('Failed to fetch dynamically imported module');
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  useEnglish();
  host = document.createElement('div');
  host.className = 'cockpit';
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const settle = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));

describe('a viewer chunk that fails to load', () => {
  it('shows a note with Open in its own app inside the tab, not a pane-wide error', async () => {
    const file: FileBytes = { path: 'a.pdf', name: 'a.pdf', size: 10, kind: 'bytes', base64: PDF_SAMPLE };
    const api = fakeApi({}, {}, { 'a.pdf': file });
    await act(async () => root.render(<FileTab paneId="p1" path="a.pdf" canTell={false} api={api} />));
    for (let i = 0; i < 40 && !host.querySelector('[data-testid="viewer-failed"]'); i++) await settle(50);
    const note = host.querySelector('[data-testid="viewer-failed"]');
    expect(note?.textContent).toContain("Couldn't open this viewer");
    expect(loads.count).toBeGreaterThanOrEqual(1);
    // The rest of the tab (its header) is still there.
    expect(host.querySelector('section')).not.toBeNull();
    const open = [...note!.querySelectorAll('button')].find((b) => b.textContent === 'Open in its own app');
    await act(async () => open!.click());
    expect(api.openDefault).toHaveBeenCalledWith('p1', 'a.pdf');
  });
});
