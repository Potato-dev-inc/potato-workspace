// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileTab } from './FileTab';
import { fakeApi, stubInflate } from './fakes';
import { SandboxFrame, sandboxAttribute, sandboxDocument, sandboxPolicy } from './SandboxFrame';
import { sanitiseDocxHtml } from './sanitise-docx';
import { SHEET_ROW_CAP } from './SheetView';
import { looksLikePdf } from './PdfView';
import { richKindOf } from './rich-kind';
import { CSV_SAMPLE, DOCX_SAMPLE, PDF_SAMPLE, XLSX_TWO_SHEETS } from './office-fixtures';
import { bytesOf, type FileBytes, type FileContent } from '../../lib/files-api';
import { useEnglish } from '../../i18n/test-utils';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
});

const settle = (ms = 0) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
const bytesFile = (p: string, base64: string): FileBytes => ({ path: p, name: p.slice(p.lastIndexOf('/') + 1), size: base64.length, kind: 'bytes', base64 });

/** Opens a path in the file tab and waits until the lazy viewer has shown `selector`. */
async function open(p: string, api: ReturnType<typeof fakeApi>, selector: string) {
  await act(async () => root.render(<FileTab paneId="p1" path={p} canTell={false} api={api} />));
  for (let i = 0; i < 80 && !host.querySelector(selector); i++) await settle(50);
  return host.querySelector(selector);
}
const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label);

describe('the Word viewer', () => {
  const api = () => fakeApi({}, {}, { 'plan.docx': bytesFile('plan.docx', DOCX_SAMPLE) });

  it('shows headings, a list, a table and a picture', async () => {
    Object.assign(URL, { createObjectURL: () => 'blob:fake-picture', revokeObjectURL: vi.fn() });
    // The web view inflates a picture with DecompressionStream; jsdom has none, node has the same one.
    stubInflate();
    const page = await open('plan.docx', api(), '[data-testid="file-docx"]');
    expect(page).not.toBeNull();
    expect(page!.querySelector('h1')?.textContent).toBe('Quarterly plan');
    expect(page!.querySelector('h2')?.textContent).toBe('Goals');
    expect([...page!.querySelectorAll('li')].map((l) => l.textContent)).toEqual(['Ship the new sign-in', 'Fix the invoice emails']);
    expect([...page!.querySelectorAll('th, td')].map((c) => c.textContent)).toEqual(['Month', 'Owner', 'June', 'Mei', 'July', 'Sam']);
    // The picture is a placeholder first and loads from the document after (it is an object address, not a data one).
    const img = page!.querySelector('img')!;
    await vi.waitFor(() => expect(img.getAttribute('src')).toBe('blob:fake-picture'));
  });

  it('keeps a web link and strips a javascript: link from the document', async () => {
    const page = await open('plan.docx', api(), '[data-testid="file-docx"]');
    const links = [...page!.querySelectorAll('a')];
    expect(links.find((a) => a.textContent === 'Read the full plan')?.getAttribute('href')).toBe('https://example.com/plan');
    expect(links.find((a) => a.textContent === 'A link that must be stripped')?.hasAttribute('href')).toBe(false);
  });

  it('has Open in Word and Show as text', async () => {
    const a = api();
    await open('plan.docx', a, '[data-testid="file-docx"]');
    await act(async () => button('Open in Word')!.click());
    expect(a.openDefault).toHaveBeenCalledWith('p1', 'plan.docx');
    await act(async () => button('Show as text')!.click());
    await vi.waitFor(() => expect(host.querySelector('[data-testid="file-docx-text"]')?.textContent).toContain('Quarterly plan'));
    expect(host.querySelector('[data-testid="file-docx"]')).toBeNull();
    // Word files are never read as text: only the byte read is used.
    expect(a.read).not.toHaveBeenCalled();
  });

  it('says so when the file is too big', async () => {
    const a = fakeApi({}, {}, { 'big.docx': { path: 'big.docx', name: 'big.docx', size: 20 * 1024 * 1024, kind: 'too_large', base64: null } });
    const note = await open('big.docx', a, '[data-testid="file-too-large"]');
    expect(note?.textContent).toContain('The limit is 500 MB');
  });
});

describe('the sanitiser', () => {
  it('strips scripts, event handlers, frames, forms and script links', () => {
    const dirty =
      '<h1 onclick="x()">Title</h1><script>alert(1)</script><img src="x" onerror="alert(2)"><img src="data:image/png;base64,AAAA" alt="ok">' +
      '<iframe src="https://evil.example"></iframe><form action="https://evil.example"><input name="a"></form><style>body{display:none}</style>' +
      '<a href="javascript:alert(3)">bad</a><a href="https://example.com">good</a><svg onload="alert(4)"></svg><object data="x"></object>';
    const clean = sanitiseDocxHtml(dirty);
    expect(clean).not.toMatch(/<script|onerror|onclick|onload|<iframe|<form|<input|<style|<svg|<object|javascript:/i);
    expect(clean).toContain('<h1>Title</h1>');
    expect(clean).toContain('data:image/png;base64,AAAA');
    expect(clean).toContain('href="https://example.com"');
  });
});

describe('the spreadsheet viewer', () => {
  it('shows a CSV file as a table, with a quoted comma kept in one cell', async () => {
    const a = fakeApi({}, {}, { 'people.csv': bytesFile('people.csv', CSV_SAMPLE) });
    const sheet = await open('people.csv', a, '[data-testid="file-sheet"]');
    expect([...sheet!.querySelectorAll('tr')].map((r) => [...r.children].map((c) => c.textContent))).toEqual([
      ['Name', 'City', 'Score'],
      ['Mei', 'Taipei', '9'],
      ['Sam, Jr.', 'Tainan', '7'],
    ]);
    expect(sheet!.querySelector('[role="tablist"]')).toBeNull();
  });

  it('shows the first sheet of a workbook and lets the person pick the other one', async () => {
    const a = fakeApi({}, {}, { 'shop.xlsx': bytesFile('shop.xlsx', XLSX_TWO_SHEETS) });
    const sheet = await open('shop.xlsx', a, '[data-testid="file-sheet"]');
    const tabs = [...sheet!.querySelectorAll('[role="tab"]')];
    expect(tabs.map((t) => t.textContent)).toEqual(['Menu', 'Visits']);
    expect([...sheet!.querySelectorAll('td')].map((c) => c.textContent)).toEqual(['Tea', '3.5', 'Cake', '6']);
    await act(async () => (tabs[1] as HTMLElement).click());
    expect([...host.querySelectorAll('[data-testid="file-sheet"] td')].map((c) => c.textContent)).toEqual(['Mon', '12', 'Tue', '20']);
    await act(async () => button('Open in Excel')!.click());
    expect(a.openDefault).toHaveBeenCalledWith('p1', 'shop.xlsx');
  });

  it('cuts a long sheet at the row cap and offers Open in Excel', async () => {
    const rows = Array.from({ length: SHEET_ROW_CAP + 40 }, (_, i) => [`r${i}`, i]);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), 'Long');
    const base64 = XLSX.write(book, { type: 'base64', bookType: 'xlsx' }) as string;
    const a = fakeApi({}, {}, { 'long.xlsx': bytesFile('long.xlsx', base64) });
    const sheet = await open('long.xlsx', a, '[data-testid="file-sheet"]');
    expect(sheet!.querySelectorAll('tr').length).toBe(SHEET_ROW_CAP);
    expect(host.querySelector('[data-testid="file-sheet-capped"]')?.textContent).toContain('Open in Excel');
  });
});

describe('the PDF viewer', () => {
  it('shows the file in the system viewer through a blob address typed as a PDF', async () => {
    const create = vi.fn((_blob: Blob) => 'blob:fake-pdf');
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() });
    const a = fakeApi({}, {}, { 'paper.pdf': bytesFile('paper.pdf', PDF_SAMPLE) });
    const frame = (await open('paper.pdf', a, '[data-testid="pdf-frame"]')) as HTMLIFrameElement;
    expect(frame.getAttribute('src')).toBe('blob:fake-pdf');
    expect(create).toHaveBeenCalledTimes(1);
    const blob = create.mock.calls[0][0];
    expect(blob.type).toBe('application/pdf');
    expect(blob.size).toBe(atob(PDF_SAMPLE).length);
    expect(looksLikePdf(bytesOf(PDF_SAMPLE))).toBe(true);
  });

  it('refuses a file that only has a .pdf name', async () => {
    const create = vi.fn(() => 'blob:never');
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() });
    const a = fakeApi({}, {}, { 'fake.pdf': bytesFile('fake.pdf', btoa('<html><script>alert(1)</script>')) });
    const note = await open('fake.pdf', a, '[role="alert"]');
    expect(note?.textContent).toContain('not a PDF');
    expect(host.querySelector('iframe')).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });
});

describe('the web page preview', () => {
  const html: FileContent = { path: 'site/index.html', name: 'index.html', size: 40, kind: 'text', text: '<!doctype html><h1>Hi</h1><script>parent.x=1</script>' };

  it('shows an .html file in the sandbox and can show it as text', async () => {
    const a = fakeApi({}, { 'site/index.html': html });
    const frame = (await open('site/index.html', a, '[data-testid="sandbox-frame"]')) as HTMLIFrameElement;
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('srcdoc')).toContain('Content-Security-Policy');
    expect(frame.getAttribute('srcdoc')).toContain('<h1>Hi</h1>');
    expect(button('Show as text')).toBeTruthy();
  });
});

describe('the sandbox frame', () => {
  it('never allows the app origin, navigation, popups or forms, with or without scripts', () => {
    expect(sandboxAttribute()).toBe('');
    expect(sandboxAttribute({ allowScripts: true })).toBe('allow-scripts');
  });

  it('puts a policy first that blocks the network, and keeps a doctype in front', () => {
    expect(sandboxPolicy()).toContain("default-src 'none'");
    expect(sandboxPolicy()).not.toContain('script-src');
    expect(sandboxPolicy({ allowScripts: true })).toContain("script-src 'unsafe-inline'");
    expect(sandboxPolicy({ allowScripts: true })).not.toContain('connect-src *');
    const doc = sandboxDocument('<!DOCTYPE html><p>x</p>');
    expect(doc.startsWith('<!DOCTYPE html><meta http-equiv="Content-Security-Policy"')).toBe(true);
    expect(sandboxDocument('<p>x</p>').startsWith('<meta http-equiv="Content-Security-Policy"')).toBe(true);
  });

  it('renders a frame without same-origin when given a page', async () => {
    await act(async () => root.render(<SandboxFrame html="<p>a</p>" title="t" allowScripts />));
    const frame = host.querySelector('iframe')!;
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
  });
});

describe('which files get a viewer', () => {
  it('names the kind by extension', () => {
    expect(richKindOf('a/b.DOCX')).toBe('docx');
    expect(richKindOf('x.xlsx')).toBe('sheet');
    expect(richKindOf('x.csv')).toBe('sheet');
    expect(richKindOf('x.pdf')).toBe('pdf');
    expect(richKindOf('x.htm')).toBe('html');
    expect(richKindOf('x.ts')).toBeNull();
  });
});

describe('lazy chunks', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const src = path.resolve(dir, '../..');
  const walk = (d: string): string[] =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));

  it('only the viewers themselves import the heavy libraries', () => {
    const allowed = new Set(['DocxView.tsx', 'docx-engine.ts', 'sanitise-docx.ts', 'SheetView.tsx', 'sheet-read.ts', 'rich-viewers.test.tsx']);
    const heavy = /from ['"](mammoth[^'"]*|xlsx|dompurify)['"]/;
    const offenders = walk(src)
      .filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith('.d.ts'))
      .filter((f) => heavy.test(readFileSync(f, 'utf8')) && !allowed.has(path.basename(f)))
      .map((f) => path.relative(src, f));
    expect(offenders).toEqual([]);
  });

  it('the file tab loads each viewer with a dynamic import, never a plain one', () => {
    const tab = readFileSync(path.join(dir, 'FileTab.tsx'), 'utf8');
    for (const view of ['DocxView', 'SheetView', 'PdfView', 'HtmlView']) {
      expect(tab).toContain(`import('./${view}')`);
      expect(tab).not.toMatch(new RegExp(`^import .* from './${view}'`, 'm'));
    }
    expect(tab).not.toMatch(/from 'xlsx'|from 'mammoth|from 'dompurify'|from '\.\/sanitise-docx'/);
  });
});
