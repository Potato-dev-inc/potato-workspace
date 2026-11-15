// @vitest-environment jsdom
// Word files get pages by their measured height: a long file with no page breaks shows several pages, each with the
// header, the footer and its own page number; tables split between rows and repeat their header row; footnotes sit at the
// foot of the page that holds their mark and endnotes at the end; text boxes and pictures float beside the text. The first
// group goes through the real file tab (heights are estimated there: jsdom has no layout); the second feeds the
// paginator a stubbed layout to prove the measured path.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileTab } from './FileTab';
import { fakeApi, stubInflate } from './fakes';
import { paginateDocx } from './docx-paginate';
import { safeStyle } from './sanitise-docx';
import { longReportBase64, type PagesOptions } from './word-pages-fixture';
import { useEnglish } from '../../i18n/test-utils';
import type { FileBytes } from '../../lib/files-api';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// Building the zip and drawing 7 pages takes a second alone and several when the whole suite runs at once.
vi.setConfig({ testTimeout: 30_000 });

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

async function openLong(options: PagesOptions = {}) {
  Object.assign(URL, { createObjectURL: () => 'blob:fake-picture', revokeObjectURL: vi.fn() });
  stubInflate();
  const base64 = await longReportBase64(options);
  const file: FileBytes = { path: 'review.docx', name: 'review.docx', size: base64.length, kind: 'bytes', base64 };
  const api = fakeApi({}, {}, { 'review.docx': file });
  await act(async () => root.render(<FileTab paneId="p1" path="review.docx" canTell={false} api={api} />));
  for (let i = 0; i < 100 && !host.querySelector('[data-testid="file-docx"]'); i++) await settle(50);
  return host.querySelector<HTMLElement>('[data-testid="file-docx"]')!;
}

const style = (el: Element | null | undefined) => (el?.getAttribute('style') ?? '').toLowerCase();
const sheetsOf = (pages: HTMLElement) => [...pages.querySelectorAll<HTMLElement>('.ck-wp-sheet')];

describe('a long Word file with no page breaks', () => {
  it('shows several pages, each as big as the paper, with header, footer and its own page number', async () => {
    const pages = await openLong();
    const sheets = sheetsOf(pages);
    expect(sheets.length).toBeGreaterThanOrEqual(4);
    for (const [i, sheet] of sheets.entries()) {
      expect(style(sheet)).toContain('width:793.73px');
      expect(style(sheet)).toContain('min-height:1122.53px');
      expect(sheet.querySelector('.ck-wp-head')?.textContent).toBe('Care Station Annual Review');
      expect(sheet.querySelector('.ck-wp-foot')?.textContent).toBe(`Page ${i + 1} of ${sheets.length}`);
      expect(sheet.querySelector('.ck-wp-body')?.children.length).toBeGreaterThan(0);
      expect(sheet.querySelector('.ck-wp-rest')).toBeNull();
    }
    // The text runs on in order: paragraph 1 is on the first page, the last one on the last page.
    expect(sheets[0].textContent).toContain('1. The group met');
    expect(sheets[sheets.length - 1].textContent).toContain('40. The group met');
    expect(pages.querySelectorAll('.ck-wp-body p').length).toBeGreaterThan(40);
  });

  it('uses the paper size of the file (Letter is not A4)', async () => {
    const pages = await openLong({ letter: true, tableRows: 0 });
    const first = sheetsOf(pages)[0];
    expect(style(first)).toContain('width:816px');
    expect(style(first)).toContain('min-height:1056px');
    expect(sheetsOf(pages).length).toBeGreaterThanOrEqual(4);
  });

  it('cuts a table between rows and repeats its header row on each page it reaches', async () => {
    const pages = await openLong({ tableRows: 80 });
    const tables = [...pages.querySelectorAll('table')];
    expect(tables.length).toBeGreaterThanOrEqual(2);
    for (const table of tables) {
      expect(table.querySelector('tr')?.textContent).toBe('DateActivityPeople');
      expect(table.querySelector('colgroup')).not.toBeNull();
    }
    // Each part sits on a different page, and every data row appears exactly once.
    expect(new Set(tables.map((t) => t.closest('.ck-wp-sheet'))).size).toBe(tables.length);
    const dates = [...pages.querySelectorAll('table td')].map((td) => td.textContent).filter((t) => /^11\//.test(t ?? ''));
    expect(dates).toHaveLength(80);
    expect(new Set(dates).size).toBe(80);
    expect(dates[0]).toBe('11/1');
    expect(dates[79]).toBe('11/80');
  });

  it('puts a footnote at the foot of the page that holds its mark, and endnotes at the end', async () => {
    const pages = await openLong();
    const sheets = sheetsOf(pages);
    const marks = [...pages.querySelectorAll('.ck-wp-fnref')];
    expect(marks.map((m) => m.textContent)).toEqual(['1', '2', 'i']);
    const first = marks[0].closest('.ck-wp-sheet')!;
    expect(first.querySelector('.ck-wp-fns .ck-wp-fn')?.textContent).toContain('Figures come from the sign-in sheet.');
    expect(first.querySelector('.ck-wp-fns .ck-wp-fn')?.textContent?.startsWith('1')).toBe(true);
    const second = marks[1].closest('.ck-wp-sheet')!;
    expect(second.querySelector('#fn-2')?.textContent).toContain('Cooking days are counted once per month.');
    // Notes sit between the text and the footer.
    const kinds = [...first.children].map((c) => c.className.split(' ')[0]);
    expect(kinds.indexOf('ck-wp-fns')).toBeGreaterThan(kinds.indexOf('ck-wp-body'));
    expect(kinds.indexOf('ck-wp-fns')).toBeLessThan(kinds.indexOf('ck-wp-foot'));
    // No page shows a note whose mark is on another page.
    for (const sheet of sheets) {
      const here = [...sheet.querySelectorAll('[id^="fnref-"]')].map((m) => m.id.replace('fnref-', ''));
      const shown = [...sheet.querySelectorAll('.ck-wp-fns .ck-wp-fn')].map((n) => n.id.replace('fn-', ''));
      expect(shown).toEqual(here);
    }
    // The endnote follows the last paragraph, on the last page.
    const last = sheets[sheets.length - 1];
    expect(last.querySelector('#en-1')?.textContent).toContain('Thanks to the volunteers');
    expect(last.querySelector('.ck-wp-enrule')).not.toBeNull();
    expect(last.querySelector('.ck-wp-fns')).toBeNull();
  });

  it('places a text box and a picture beside the text, to the left or right', async () => {
    const pages = await openLong();
    const box = pages.querySelector<HTMLElement>('.ck-wp-box')!;
    expect(box.textContent).toContain('Key number');
    expect(box.textContent).toContain('1,240 meals shared this year');
    expect(style(box)).toContain('float:left');
    expect(style(box)).toContain('width:240px'); // 2286000 EMU
    expect(style(box)).toContain('border:1px solid #bf9000');
    expect(style(box)).toContain('background-color:#fff2cc');
    expect(box.querySelectorAll('.ck-wp-boxp')).toHaveLength(2);
    // The box is inside the page text and is not a block of its own (it floats in its paragraph).
    expect(box.closest('p')).not.toBeNull();
    const img = pages.querySelector<HTMLImageElement>('img.ck-wp-float')!;
    expect(style(img)).toContain('float:right');
    expect(style(img)).toContain('width:200px');
    await vi.waitFor(() => expect(img.getAttribute('src')).toBe('blob:fake-picture'));
  });

  it('keeps the text view and a document without notes, boxes or tables working', async () => {
    const pages = await openLong({ footnotes: false, textBox: false, floatingPicture: false, tableRows: 0, paragraphs: 3 });
    expect(sheetsOf(pages)).toHaveLength(1);
    expect(pages.querySelector('.ck-wp-fns')).toBeNull();
    expect(pages.querySelector('.ck-wp-foot')?.textContent).toBe('Page 1 of 1');
  });
});

describe('what a Word file cannot make the page do with floats', () => {
  it('lets float only be left, right or none', () => {
    expect(safeStyle('float:left;margin:0 8px 0 0')).toBe('float:left;margin:0 8px 0 0');
    expect(safeStyle('float:inherit;position:absolute;box-sizing:border-box')).toBe('box-sizing:border-box');
    expect(safeStyle('box-sizing:content-box')).toBe('');
  });
});

// A stand-in for the layout: paragraphs are 300 px, notes 250 px, table rows 100 px, list items 50 px, the header and
// the footer 100 px each, in a page 1000 px high (so 800 px of text, 1 + 1 paragraphs and a bit).
function stubLayout() {
  const heightOf = (el: Element): number => {
    if (el.classList.contains('ck-wp-head') || el.classList.contains('ck-wp-foot')) return 100;
    if (el.classList.contains('ck-wp-fn')) return 250;
    if (el.tagName === 'P' || el.tagName === 'H1') return 300;
    if (el.tagName === 'TR') return 100;
    if (el.tagName === 'LI') return 50;
    if (el.tagName === 'TABLE') return el.querySelectorAll('tr').length * 100;
    if (el.tagName === 'UL') return el.children.length * 50;
    return 1;
  };
  const topOf = (el: Element): number => {
    const parent = el.parentElement;
    if (!parent) return 0;
    if (parent.classList.contains('ck-wp-body') || parent.classList.contains('ck-wp-fns')) {
      let y = 0;
      for (const sib of Array.from(parent.children)) {
        if (sib === el) break;
        y += heightOf(sib);
      }
      return y;
    }
    if (el.tagName === 'TR') {
      const table = el.closest('table')!;
      return topOf(table) + Array.from(table.querySelectorAll('tr')).indexOf(el as HTMLTableRowElement) * 100;
    }
    if (el.tagName === 'LI') return topOf(parent) + Array.from(parent.children).indexOf(el) * 50;
    return 0;
  };
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const top = topOf(this);
    const h = heightOf(this);
    return { top, bottom: top + h, height: h, left: 0, right: 0, width: 600, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
  });
}

const sheet = (body: string, extra = '') =>
  `<div class="ck-wp-sheet" style="width:800px;min-height:1000px"><div class="ck-wp-head" style="padding:10px 50px 0 50px;min-height:96px"><span class="ck-wp-pageno">1</span></div>` +
  `<div class="ck-wp-body" style="padding:0 50px 0 50px">${body}</div>${extra}<div class="ck-wp-foot" style="padding:0 50px 10px 50px;min-height:96px">Page <span class="ck-wp-pageno">1</span> of <span class="ck-wp-numpages">1</span></div></div>`;
const parse = (html: string) => {
  const d = document.createElement('div');
  d.innerHTML = html;
  return [...d.querySelectorAll<HTMLElement>('.ck-wp-sheet')];
};

describe('the paginator with measured heights', () => {
  it('fills each page up to the space between header and footer', async () => {
    stubLayout();
    const html = await paginateDocx(sheet('<p>a</p>'.repeat(5)).replace('<p>a</p><p>a</p>', '<p>a</p><p>b</p>'), host);
    const sheets = parse(html);
    // 800 px of room, 300 px each: two per page, so 5 paragraphs make 3 pages.
    expect(sheets.map((s) => s.querySelectorAll('.ck-wp-body > p').length)).toEqual([2, 2, 1]);
    expect(sheets.map((s) => s.querySelector('.ck-wp-foot')?.textContent)).toEqual(['Page 1 of 3', 'Page 2 of 3', 'Page 3 of 3']);
    expect(sheets.every((s) => style(s) === 'width:800px;min-height:1000px')).toBe(true);
    expect(host.querySelector('.ck-wp-pages')).toBeNull();
  });

  it('cuts a table between rows, repeats the header rows, and keeps merged rows together', async () => {
    stubLayout();
    const rows = (n: number) => Array.from({ length: n }, (_, i) => `<tr><td>r${i + 1}</td></tr>`).join('');
    const table = `<table class="ck-wp-tbl" style="width:100px"><colgroup><col></colgroup><tbody><tr class="ck-wp-thead"><td>H</td></tr>${rows(12)}</tbody></table>`;
    const html = await paginateDocx(sheet(`<p>x</p>${table}`), host);
    const sheets = parse(html);
    const parts = sheets.map((s) => [...s.querySelectorAll('tr')].map((r) => r.textContent));
    // Page 1: the paragraph (300) + header and 4 rows (500) = 800. Later pages: header + 7 rows.
    expect(parts[0]).toEqual(['H', 'r1', 'r2', 'r3', 'r4']);
    expect(parts[1]).toEqual(['H', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10', 'r11']);
    expect(parts[2]).toEqual(['H', 'r12']);
    expect(sheets.every((s) => s.querySelector('table colgroup'))).toBe(true);

    // A row that a vertical merge continues from stays with the rows below it.
    const merged = `<table class="ck-wp-tbl"><tbody><tr><td>a</td></tr><tr><td>b</td></tr><tr><td>c</td></tr><tr><td>d</td></tr><tr><td rowspan="2">e</td></tr><tr><td>f</td></tr><tr><td>g</td></tr><tr><td rowspan="2">h</td></tr><tr><td>i</td></tr></tbody></table>`;
    const mergedHtml = await paginateDocx(sheet(`<p>x</p>${merged}`), host);
    const text = parse(mergedHtml).map((s) => [...s.querySelectorAll('tr')].map((r) => r.textContent).join(''));
    expect(text).toEqual(['abcdef', 'ghi']);
  });

  it('cuts a long list between items', async () => {
    stubLayout();
    const items = Array.from({ length: 20 }, (_, i) => `<li value="${i + 1}">i${i + 1}</li>`).join('');
    const html = await paginateDocx(sheet(`<ul class="ck-wp-list">${items}</ul>`), host);
    const sheets = parse(html);
    expect(sheets).toHaveLength(2);
    expect([...sheets[1].querySelectorAll('li')][0].getAttribute('value')).toBe('17');
    expect(sheets.flatMap((s) => [...s.querySelectorAll('li')]).map((l) => l.textContent)).toHaveLength(20);
  });

  it('makes room for a footnote and keeps a heading with the text after it', async () => {
    stubLayout();
    const note = '<div class="ck-wp-fns" style="padding:0 50px 0 50px"><div class="ck-wp-fn" id="fn-1">1 a note</div></div>';
    const html = await paginateDocx(sheet('<p>a<sup class="ck-wp-fnref" id="fnref-1">1</sup></p><p>b</p><p>c</p>', note), host);
    const sheets = parse(html);
    // The note takes 250 px (and a rule), so the page holds one paragraph and the note, not two paragraphs.
    expect(sheets.map((s) => s.querySelectorAll('.ck-wp-body > p').length)).toEqual([1, 2]);
    expect(sheets[0].querySelector('.ck-wp-fns #fn-1')).not.toBeNull();
    expect(sheets[1].querySelector('.ck-wp-fns')).toBeNull();

    const headed = await paginateDocx(sheet('<p>a</p><h1>Title</h1><p>b</p>'), host);
    const parts = parse(headed).map((s) => [...s.querySelectorAll('.ck-wp-body > *')].map((e) => e.textContent).join(','));
    expect(parts).toEqual(['a', 'Title,b']);
  });

  it('uses the ordinary header and footer after a first-page one', async () => {
    stubLayout();
    const rest =
      '<div class="ck-wp-head ck-wp-rest" style="display:none;min-height:96px">ordinary head</div>';
    const first = sheet('<p>a</p><p>b</p><p>c</p>').replace('<div class="ck-wp-body"', `${rest}<div class="ck-wp-body"`).replace('<span class="ck-wp-pageno">1</span></div>', 'cover head</div>');
    const sheets = parse(await paginateDocx(first, host));
    expect(sheets.map((s) => s.querySelector('.ck-wp-head')?.textContent)).toEqual(['cover head', 'ordinary head']);
    expect(sheets[1].querySelector('.ck-wp-head')?.getAttribute('style')).not.toContain('display:none');
  });

  it('leaves the page as it is when the page does not have a size', async () => {
    const odd = '<div class="ck-wp-sheet"><div class="ck-wp-body"><p>a</p></div></div>';
    expect(await paginateDocx(odd, host)).toContain('<p>a</p>');
    expect(await paginateDocx('<p>plain</p>', host)).toBe('<p>plain</p>');
  });
});
