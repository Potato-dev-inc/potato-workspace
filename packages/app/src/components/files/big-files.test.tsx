// @vitest-environment jsdom
// Big files: a generated 60 MB Word file full of photos opens (text first, pictures only as they come near), the
// "too big" message always has a way out, and the screen wires it all in. The big file is made by
// scripts/fixtures/big-docx/make-big-docx.mjs at test time (nothing is committed).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileTab } from './FileTab';
import { fakeApi, stubInflate } from './fakes';
import { bytesReader, openSlim, type RangeReader } from './docx-zip';
import { openDocx } from './office-client';
import { sanitiseDocxPage } from './sanitise-docx';
import { useEnglish } from '../../i18n/test-utils';
import type { FileStream } from '../../lib/files-api';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../scripts/fixtures/big-docx/make-big-docx.mjs');
let dir: string;
let big: Uint8Array;
let small: Uint8Array;
const make = (name: string, mb: number, pictures: number) => {
  const file = path.join(dir, name);
  execFileSync(process.execPath, [script, '--mb', String(mb), '--pictures', String(pictures), '--out', file], { stdio: 'ignore' });
  return new Uint8Array(readFileSync(file));
};
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'pm-big-'));
  big = make('big.docx', 60, 40);
  small = make('small.docx', 3, 12);
}, 120_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const stream = (name: string, bytes: Uint8Array): FileStream => ({ path: name, name, size: bytes.length, kind: 'stream', limit: 500 * 1024 * 1024, source: { bytes } });
const api = (file: FileStream) => fakeApi({ openBytes: vi.fn(async () => file) });
const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label);

describe('a 60 MB Word file full of photos', () => {
  it('is bigger than the old 15 MB limit and shows its text without reading one picture', async () => {
    expect(big.length).toBeGreaterThan(55 * 1024 * 1024);
    const started = performance.now();
    const session = openDocx({ bytes: big });
    const { html, pictures } = await session.opened;
    const text = performance.now() - started;
    const page = sanitiseDocxPage(html, 2500);
    expect(pictures).toBe(40);
    expect(page.html).toContain('Monthly report');
    expect(page.html).toContain('Activity 40');
    // Every photo is a placeholder: no picture bytes are in the page.
    expect(page.html.length).toBeLessThan(200_000);
    expect(page.html).not.toMatch(/data:image\/png;base64,iVBOR/);
    expect(text).toBeLessThan(15_000);
    // A picture is read only when asked for.
    const blob = await session.picture(3);
    expect(blob?.type).toBe('image/png');
    expect(blob!.size).toBeGreaterThan(500_000);
    session.close();
  }, 120_000);

  it('reads only the zip directory and the small parts, never the photos, until one is asked for', async () => {
    let read = 0;
    const inner = bytesReader(big);
    const counting: RangeReader = { size: inner.size, read: async (a, b) => ((read += b - a + 1), inner.read(a, b)) };
    const slim = await openSlim(counting);
    expect(read).toBeLessThan(1024 * 1024);
    expect(slim.slim.byteLength).toBeLessThan(1024 * 1024);
    const photo = await slim.readMedia('word/media/photo5.png');
    expect(photo.byteLength).toBeGreaterThan(1_000_000);
    expect(read).toBeGreaterThan(photo.byteLength);
    expect(read).toBeLessThan(photo.byteLength + 1024 * 1024);
    // The picture is the real one: a PNG.
    expect(Array.from(new Uint8Array(photo).slice(0, 4))).toEqual([137, 80, 78, 71]);
    await expect(slim.readMedia('word/media/../../etc/passwd')).rejects.toThrow();
  }, 60_000);

  it('opens in the file tab: text at once, a picture only when it comes near', async () => {
    stubInflate();
    const made: Blob[] = [];
    Object.assign(URL, {
      createObjectURL: vi.fn((b: Blob) => (made.push(b), `blob:photo-${made.length}`)),
      revokeObjectURL: vi.fn(),
    });
    const watched: Element[] = [];
    let report: (target: Element) => void = () => undefined;
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(cb: (e: Array<{ target: Element; isIntersecting: boolean }>) => void) {
          report = (target) => cb([{ target, isIntersecting: true }]);
        }
        observe(el: Element) {
          watched.push(el);
        }
        unobserve() {}
        disconnect() {}
      },
    );
    await act(async () => root.render(<FileTab paneId="p1" path="reports/big.docx" canTell={false} api={api(stream('big.docx', small))} />));
    await vi.waitFor(() => expect(host.querySelector('[data-testid="file-docx"] h1')?.textContent).toBe('Monthly report'));
    await vi.waitFor(() => expect(watched).toHaveLength(12));
    // Text is on screen; no picture has been read yet.
    expect(made).toHaveLength(0);
    expect(host.querySelectorAll('img.is-loaded')).toHaveLength(0);
    await act(async () => report(watched[2]));
    await vi.waitFor(() => expect(host.querySelectorAll('img.is-loaded')).toHaveLength(1));
    expect((watched[2] as HTMLImageElement).getAttribute('src')).toBe('blob:photo-1');
    expect(made).toHaveLength(1);
  }, 60_000);

  it('a document with too many blocks is cut after the cap, not refused', () => {
    const page = sanitiseDocxPage('<p>a</p>'.repeat(10), 4);
    expect(page.truncated).toBe(true);
    expect(page.html).toBe('<p>a</p>'.repeat(4));
  });
});

describe('the too-big message is never a dead end', () => {
  const huge = (name: string): FileStream => ({ path: name, name, size: 600 * 1024 * 1024, kind: 'too_large', limit: 500 * 1024 * 1024 });

  it.each([
    ['report.docx', 'Open in Word'],
    ['costs.xlsx', 'Open in Excel'],
    ['book.pdf', 'Open in its own app'],
  ])('%s over 500 MB says the limit and offers its program and Show in folder', async (name, label) => {
    const a = api(huge(name));
    await act(async () => root.render(<FileTab paneId="p1" path={`docs/${name}`} canTell={false} api={a} />));
    await vi.waitFor(() => expect(host.querySelector('[data-testid="file-too-large"]')).not.toBeNull());
    expect(host.querySelector('[data-testid="file-too-large"]')?.textContent).toBe('This file is too big to open here (600.0 MB). The limit is 500 MB.');
    const body = host.querySelector('.ck-file-body')!;
    const inBody = (l: string) => [...body.querySelectorAll('button')].find((b) => b.textContent === l);
    await act(async () => inBody(label)!.click());
    expect(a.openDefault).toHaveBeenCalledWith('p1', `docs/${name}`);
    await act(async () => inBody('Show in folder')!.click());
    expect(a.reveal).toHaveBeenCalledWith('p1', `docs/${name}`);
  });

  it('a text file over 2 MB can be shown in its folder too', async () => {
    const a = fakeApi({}, { 'big.log': { path: 'big.log', name: 'big.log', size: 3 * 1024 * 1024, kind: 'too_large' } });
    await act(async () => root.render(<FileTab paneId="p1" path="big.log" canTell={false} api={a} />));
    await vi.waitFor(() => expect(host.querySelector('[data-testid="file-too-large"]')).not.toBeNull());
    await act(async () => button('Show in folder')!.click());
    expect(a.reveal).toHaveBeenCalledWith('p1', 'big.log');
    // A .log has no program the app may start, so only the folder button is there.
    expect(button('Open in its own app')).toBeUndefined();
  });
});
