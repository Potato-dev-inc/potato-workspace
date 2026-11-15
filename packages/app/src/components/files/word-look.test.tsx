// @vitest-environment jsdom
// Word files look like Word: pages with margins, the document's fonts and alignment, table borders and shading,
// merged cells, header and footer with page numbers, a page break, a list and a picture; and nothing in the file's
// styling can run or fetch. Everything goes through the real file tab.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileTab } from './FileTab';
import { fakeApi, stubInflate } from './fakes';
import { safeStyle, sanitiseDocxPage } from './sanitise-docx';
import { styledReportBase64 } from './word-look-fixture';
import { renderWord } from './docx-render';
import { useEnglish } from '../../i18n/test-utils';
import type { FileBytes } from '../../lib/files-api';

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

async function openReport(rows = 6) {
  Object.assign(URL, { createObjectURL: () => 'blob:fake-picture', revokeObjectURL: vi.fn() });
  stubInflate();
  const base64 = await styledReportBase64(rows);
  const file: FileBytes = { path: 'report.docx', name: 'report.docx', size: base64.length, kind: 'bytes', base64 };
  const api = fakeApi({}, {}, { 'report.docx': file });
  await act(async () => root.render(<FileTab paneId="p1" path="report.docx" canTell={false} api={api} />));
  for (let i = 0; i < 80 && !host.querySelector('[data-testid="file-docx"]'); i++) await settle(50);
  return host.querySelector<HTMLElement>('[data-testid="file-docx"]')!;
}

const style = (el: Element | null | undefined) => (el?.getAttribute('style') ?? '').toLowerCase();

describe('a Word file drawn like Word', () => {
  it('shows white A4 pages with the document margins, split at the page break', async () => {
    const pages = await openReport();
    const sheets = [...pages.querySelectorAll<HTMLElement>('.ck-wp-sheet')];
    expect(sheets).toHaveLength(2);
    expect(style(sheets[0])).toContain('width:793.73px');
    expect(style(sheets[0])).toContain('min-height:1122.53px');
    // Left and right margin of 1134 twips = 75.6 px, in the body of the page.
    expect(style(sheets[0].querySelector('.ck-wp-body'))).toContain('padding:0 75.6px 0 75.6px');
    expect(sheets[0].textContent).toContain('October activity report');
    expect(sheets[0].textContent).not.toContain('Notes for next month');
    expect(sheets[1].textContent).toContain('Notes for next month');
  });

  it('keeps the document fonts, sizes, colours and alignment', async () => {
    const pages = await openReport();
    const title = pages.querySelector('h1')!;
    expect(title.textContent).toBe('October activity report');
    expect(style(title)).toContain('text-align:center');
    expect(style(title)).toContain('font-size:16pt');
    expect(style(title)).toContain('font-weight:700');
    expect(style(title)).toContain('color:#1f3864');
    expect(style(title)).toContain("'calibri'");
    const station = [...pages.querySelectorAll('p')].find((p) => p.textContent?.startsWith('Station'))!;
    expect(style(station)).toContain('text-align:right');
    expect(style(station.querySelector('i, span[style*="italic"]'))).toContain('font-style:italic');
    expect(style(station.querySelector('span[style*="c00000" i]'))).toContain('color:#c00000');
  });

  it('draws the table with borders, shading, merged cells and set widths', async () => {
    const pages = await openReport();
    const table = pages.querySelector('table')!;
    expect(style(table)).toContain('border-collapse:collapse');
    expect(style(table)).toContain('width:600px'); // 9000 twips
    expect([...table.querySelectorAll('col')].map((c) => style(c))).toEqual(['width:120px', 'width:173.33px', 'width:173.33px', 'width:133.33px']);
    const cells = [...table.querySelectorAll('td')];
    const head = cells.find((c) => c.textContent === 'Date')!;
    expect(style(head)).toContain('border-top:1px solid #000');
    expect(style(head)).toContain('border-left:1px solid #000');
    expect(style(head)).toContain('background-color:#d9e2f3');
    // A cell's own border beats the table's: a double red line under the last column.
    const people = cells.find((c) => c.textContent === '12')!;
    expect(style(people)).toContain('border-bottom:3px double #c00000');
    // A merged cell spans two columns.
    expect(cells.find((c) => c.textContent === 'Health talk (two columns)')?.getAttribute('colspan')).toBe('2');
    // The table style says no space after a paragraph in a cell.
    expect(style(head.querySelector('p'))).toContain('margin-bottom:0px');
  });

  it('puts the header and footer on each page with its own page number', async () => {
    const pages = await openReport();
    const sheets = [...pages.querySelectorAll('.ck-wp-sheet')];
    for (const [i, sheet] of sheets.entries()) {
      expect(sheet.querySelector('.ck-wp-head')?.textContent).toBe('Care Station Monthly Report');
      expect(sheet.querySelector('.ck-wp-foot')?.textContent).toBe(`Page ${i + 1}`);
    }
  });

  it('numbers a list and keeps a picture in place at its size, loading it later', async () => {
    const pages = await openReport();
    const items = [...pages.querySelectorAll('li')];
    expect(items.map((l) => l.textContent)).toEqual(['Invite more neighbours', 'Buy new chairs']);
    expect(items.map((l) => l.getAttribute('value'))).toEqual(['1', '2']);
    expect(style(items[0])).toContain('list-style-type:decimal');
    const img = pages.querySelector('img')!;
    expect(style(img)).toContain('width:200px'); // 1905000 EMU
    expect(style(img)).toContain('aspect-ratio:200/100');
    await vi.waitFor(() => expect(img.getAttribute('src')).toBe('blob:fake-picture'));
  });

  it('has Fit width and 100% for the page size', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(432);
    const pages = await openReport();
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('.ck-wp-zoom')];
    expect(buttons.map((b) => b.textContent)).toEqual(['Fit width', '100%']);
    // 432 - 32 gutter = 400 px for a 793 px page.
    expect(Number(pages.getAttribute('data-zoom'))).toBeCloseTo(400 / 793.07, 2);
    await act(async () => buttons[1].click());
    expect(pages.getAttribute('data-zoom')).toBe('1.00');
    await act(async () => buttons[0].click());
    expect(Number(pages.getAttribute('data-zoom'))).toBeLessThan(0.6);
  });

  it('opens a big table report', { timeout: 30_000 }, async () => {
    const pages = await openReport(150);
    expect(pages.querySelectorAll('tr').length).toBeGreaterThanOrEqual(151); // the header row comes back on each page the table reaches
    // 150 rows do not fit one page any more: the table is cut between rows and the page break still starts a new page.
    expect(pages.querySelectorAll('.ck-wp-sheet').length).toBeGreaterThan(2);
  });
});

describe('what a Word file cannot make the page do', () => {
  it('keeps only known CSS properties with plain values', () => {
    expect(safeStyle('color:#c00000;background:url(http://x/y);width:10px')).toBe('color:#c00000;width:10px');
    expect(safeStyle('position:fixed;top:0;font-family:"Calibri",sans-serif')).toBe('font-family:"Calibri",sans-serif');
    expect(safeStyle('width:expression(alert(1));height:5px')).toBe('height:5px');
    expect(safeStyle('display:block;margin-left:4px')).toBe('margin-left:4px');
    expect(safeStyle('color:red\\;x')).toBe('');
  });

  it('strips scripts, handlers, web-address backgrounds and foreign classes from page markup', () => {
    const dirty =
      '<div class="ck-wp-sheet evil" style="width:10px;background:url(https://x/y.png)" onclick="x()"><div class="ck-wp-body"><p style="color:#000" onmouseover="x()">hi<script>alert(1)</script></p><a href="javascript:alert(1)">bad</a></div></div>';
    const { html } = sanitiseDocxPage(dirty, 100);
    expect(html).not.toMatch(/script|onclick|onmouseover|url\(|javascript:|evil/i);
    expect(html).toContain('class="ck-wp-sheet"');
    expect(html).toContain('style="width:10px"');
  });

  it('cuts a very long drawn document after the block cap and says so', () => {
    const rows = Array.from({ length: 30 }, (_, i) => `<p>row ${i}</p>`).join('');
    const out = sanitiseDocxPage(`<div class="ck-wp-sheet"><div class="ck-wp-body">${rows}</div></div>`, 10);
    expect(out.truncated).toBe(true);
    expect(out.html.match(/<p/g)).toHaveLength(10);
  });

  it('writes a link with no address when the document points somewhere that is not a web address', async () => {
    const out = await renderWord({
      part: async (name) =>
        name === 'word/document.xml'
          ? '<w:document xmlns:w="w" xmlns:r="r"><w:body><w:p><w:hyperlink r:id="x"><w:r><w:t>file link</w:t></w:r></w:hyperlink></w:p></w:body></w:document>'
          : name === 'word/_rels/document.xml.rels'
            ? '<Relationships><Relationship Id="x" Target="file:///C:/secret.txt" TargetMode="External"/></Relationships>'
            : null,
      media: async () => new ArrayBuffer(0),
    });
    expect(out.html).toContain('<a>file link</a>');
    expect(out.html).not.toContain('file:');
  });
});
