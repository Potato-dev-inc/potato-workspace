// Automatic page splitting for a Word file drawn by `docx-render.ts`. The renderer ends a page only where the document
// says so; here a page that holds more than fits (by its real height, measured in a hidden copy of the page) is cut into
// several. Paper size and margins come from the page itself (its height, its header and footer). Rules, in short:
//  - whole blocks move to the next page; a table or a list that does not fit is cut between rows (a row never splits),
//    and rows marked as header rows come back at the top of each part; rows joined by a vertical merge stay together;
//  - a heading is not left alone at the bottom of a page;
//  - a footnote sits at the bottom of the page that holds its mark; the page's text shrinks to make room;
//  - header, footer and page numbers are repeated on every page (the first-page ones only on the first).
// Where the page cannot lay out (a test, a hidden pane) the heights are estimated from the text instead.
// This works on the sanitised HTML string and returns an HTML string; it never reads anything but the page's own markup.

const NOTE_RULE = 14;
const isTable = (el: Element) => el.tagName === 'TABLE';
const isList = (el: Element) => el.tagName === 'UL' || el.tagName === 'OL';
/** The rows of a table (inside its body parts) or the items of a list. */
const rowsOf = (el: Element): HTMLElement[] =>
  (isTable(el)
    ? Array.from(el.children).flatMap((c) => (['TBODY', 'THEAD', 'TFOOT'].includes(c.tagName) ? Array.from(c.children) : c.tagName === 'TR' ? [c] : []))
    : Array.from(el.children)) as HTMLElement[];
const BASE_FONT = 14.67;

interface Layout {
  top(el: Element): number;
  bottom(el: Element): number;
  height(el: Element): number;
}

const px = (style: string | null | undefined, prop: string): number => {
  const m = new RegExp(`(?:^|;)\\s*${prop}:\\s*(-?[\\d.]+)px`).exec(style ?? '');
  return m ? Number(m[1]) : 0;
};

function textWidth(text: string): number {
  let w = 0;
  for (const ch of text) w += ch.codePointAt(0)! > 0x2e80 ? 2 : 1;
  return w;
}

/** Heights guessed from the text, for a page that cannot lay out. Rough, but steady. */
function estimate(el: Element, width: number): number {
  const style = el.getAttribute('style');
  const margins = px(style, 'margin-top') + px(style, 'margin-bottom');
  const tag = el.tagName;
  if (tag === 'TABLE') {
    let h = 0;
    for (const tr of rowsOf(el)) h += estimateRow(tr, width);
    return h;
  }
  if (tag === 'UL' || tag === 'OL') return Array.from(el.children).reduce((a, li) => a + estimate(li, width), 0);
  const font = parseFloat(/font-size:\s*([\d.]+)pt/.exec(el.innerHTML.slice(0, 600))?.[1] ?? '') * (96 / 72) || BASE_FONT;
  const lh = Number(/line-height:\s*([\d.]+)(?:;|$)/.exec(style ?? '')?.[1]) || 1.2;
  const lines = (el.textContent ?? '')
    .split('\n')
    .reduce((a, line) => a + Math.max(1, Math.ceil((textWidth(line) * font * 0.52) / Math.max(40, width))), 0);
  let extra = 0;
  for (const img of Array.from(el.querySelectorAll('img'))) {
    const s = img.getAttribute('style');
    const w = px(s, 'width');
    const ratio = /aspect-ratio:\s*(\d+)\/(\d+)/.exec(s ?? '');
    extra = Math.max(extra, w && ratio ? (w * Number(ratio[2])) / Number(ratio[1]) : 0);
  }
  return Math.max(lines * font * lh + (el.querySelectorAll('br').length ? el.querySelectorAll('br').length * font * lh : 0), extra) + margins;
}

function estimateRow(tr: Element, width: number): number {
  const cells = Array.from(tr.children);
  const per = width / Math.max(1, cells.length);
  return Math.max(20, ...cells.map((c) => estimate(c, per - 14)));
}

function realLayout(origin: number): Layout {
  return {
    top: (el) => el.getBoundingClientRect().top - origin,
    bottom: (el) => el.getBoundingClientRect().bottom - origin,
    height: (el) => el.getBoundingClientRect().height,
  };
}

/** Every block's and row's position, read once before anything moves. */
function snapshot(live: Layout, blocks: Element[]): Layout {
  const pos = new Map<Element, [number, number]>();
  for (const el of blocks) {
    pos.set(el, [live.top(el), live.bottom(el)]);
    if (isTable(el) || isList(el)) for (const row of rowsOf(el)) pos.set(row, [live.top(row), live.bottom(row)]);
  }
  const get = (el: Element) => pos.get(el) ?? [0, 0];
  return { top: (el) => get(el)[0], bottom: (el) => get(el)[1], height: (el) => get(el)[1] - get(el)[0] };
}

function estimatedLayout(body: Element, width: number): Layout {
  const pos = new Map<Element, [number, number]>();
  let y = 0;
  for (const el of Array.from(body.children)) {
    const start = y;
    if (el.tagName === 'TABLE') {
      let yy = y;
      for (const tr of rowsOf(el)) {
        const h = estimateRow(tr, width);
        pos.set(tr, [yy, yy + h]);
        yy += h;
      }
      y = yy;
    } else if (el.tagName === 'UL' || el.tagName === 'OL') {
      for (const li of Array.from(el.children)) {
        const h = estimate(li, width);
        pos.set(li, [y, y + h]);
        y += h;
      }
    } else y += estimate(el, width);
    pos.set(el, [start, y]);
  }
  const get = (el: Element) => pos.get(el) ?? [0, 0];
  return { top: (el) => get(el)[0], bottom: (el) => get(el)[1], height: (el) => get(el)[1] - get(el)[0] };
}

interface Page {
  nodes: Node[];
  fresh: boolean;
  base: number;
  offset: number;
  notes: string[];
  notesH: number;
}

const newPage = (): Page => ({ nodes: [], fresh: true, base: 0, offset: 0, notes: [], notesH: 0 });
const noteId = (el: Element) => /^fnref-(\d+)$/.exec(el.id)?.[1];
const refsIn = (el: Element): string[] => [...(/^fnref-/.test(el.id) ? [el] : []), ...Array.from(el.querySelectorAll('[id^="fnref-"]'))].map(noteId).filter((n): n is string => !!n);
const isHeading = (el: Element) => /^H[1-6]$/.test(el.tagName);

function paginateSheet(sheet: HTMLElement, doc: Document): HTMLElement[] {
  const part = (cls: string) => Array.from(sheet.children).find((c) => c.classList.contains(cls) && !c.classList.contains('ck-wp-rest')) as HTMLElement | undefined;
  const rest = (cls: string) => Array.from(sheet.children).find((c) => c.classList.contains(cls) && c.classList.contains('ck-wp-rest')) as HTMLElement | undefined;
  const body = part('ck-wp-body');
  if (!body) return [sheet];
  const head = part('ck-wp-head');
  const foot = part('ck-wp-foot');
  const fns = part('ck-wp-fns');
  const restHead = rest('ck-wp-head');
  const restFoot = rest('ck-wp-foot');
  // Measure: the sheet is in a hidden, laid-out container (or not laid out at all, then estimates).
  const pageH = px(sheet.getAttribute('style'), 'min-height');
  if (pageH <= 0) return [sheet];
  const blocks = Array.from(body.children);
  const laidOut = body.getBoundingClientRect().height > 0 || blocks.some((b) => b.getBoundingClientRect().height > 0);
  const padX = (() => {
    const m = /padding:\s*0\s+([\d.]+)px\s+0\s+([\d.]+)px/.exec(body.getAttribute('style') ?? '');
    return m ? Number(m[1]) + Number(m[2]) : 150;
  })();
  const width = px(sheet.getAttribute('style'), 'width') - padX;
  const layout = laidOut ? snapshot(realLayout(body.getBoundingClientRect().top), blocks) : estimatedLayout(body, width);
  const regionH = (el: HTMLElement | undefined, min: string, pad: string) => {
    if (!el) return 0;
    if (laidOut) return el.getBoundingClientRect().height;
    const s = el.getAttribute('style');
    return Math.max(px(s, min), px(s, pad) + (el.textContent?.trim() ? 20 : 0));
  };
  const cap = Math.max(120, pageH - regionH(head, 'min-height', 'padding-top') - regionH(foot, 'min-height', 'padding-bottom'));

  const noteEls = new Map<string, HTMLElement>();
  const noteH = new Map<string, number>();
  for (const el of Array.from(fns?.children ?? []) as HTMLElement[]) {
    const id = /^fn-(\d+)$/.exec(el.id)?.[1];
    if (!id) continue;
    noteEls.set(id, el);
    noteH.set(id, laidOut ? el.getBoundingClientRect().height : estimate(el, width));
  }

  // Cut the page into parts.
  const pages: Page[] = [newPage()];
  const cur = () => pages[pages.length - 1];
  const notesFor = (ids: string[]) => ids.filter((id) => noteEls.has(id) && !cur().notes.includes(id));
  const extraNotes = (ids: string[]) => {
    const fresh = [...new Set(notesFor(ids))];
    return fresh.reduce((a, id) => a + (noteH.get(id) ?? 0), 0) + (fresh.length && !cur().notes.length ? NOTE_RULE : 0);
  };
  const used = (bottom: number) => bottom - cur().base + cur().offset + cur().notesH + (cur().notes.length ? NOTE_RULE : 0);
  const fits = (bottom: number, ids: string[]) => used(bottom) + extraNotes(ids) <= cap;
  const addNotes = (ids: string[]) => {
    for (const id of [...new Set(notesFor(ids))]) {
      cur().notes.push(id);
      cur().notesH += noteH.get(id) ?? 0;
    }
  };
  const next = () => pages.push(newPage());
  const place = (node: Node, top: number, ids: string[]) => {
    const page = cur();
    if (page.fresh) {
      page.fresh = false;
      page.base = top;
      page.offset = 0;
    }
    page.nodes.push(node);
    addNotes(ids);
  };

  /** A table or list that does not fit whole: place its rows, cutting between rows. */
  const split = (el: HTMLElement) => {
    const rows = rowsOf(el);
    if (!rows.length) return void place(el, layout.top(el), refsIn(el));
    let headRows = isTable(el) ? rows.findIndex((r) => !r.classList.contains('ck-wp-thead')) : 0;
    if (headRows < 0) headRows = 0;
    // A header too big to repeat is not repeated.
    const headH = headRows ? layout.bottom(rows[headRows - 1]) - layout.top(rows[0]) : 0;
    if (headH > cap / 2) headRows = 0;
    const covered = new Set<number>();
    rows.forEach((r, i) => {
      for (const td of Array.from(r.children)) {
        const span = Number(td.getAttribute('rowspan') ?? 1);
        for (let k = 1; k < span; k++) covered.add(i + k);
      }
    });
    const colgroup = Array.from(el.children).find((c) => c.tagName === 'COLGROUP')?.cloneNode(true) ?? null;
    const headClones = rows.slice(0, headRows).map((r) => r.cloneNode(true));
    const shell = el.cloneNode(false) as HTMLElement;
    let chunk: HTMLElement[] = [];
    let bodyCount = 0;
    let first = true;
    const flush = () => {
      if (!chunk.length) return;
      let node: HTMLElement;
      if (first) node = el;
      else {
        node = shell.cloneNode(false) as HTMLElement;
        if (colgroup) node.appendChild(colgroup.cloneNode(true));
        if (isTable(el)) {
          const tb = doc.createElement('tbody');
          for (const h of headClones) tb.appendChild(h.cloneNode(true));
          for (const r of chunk) tb.appendChild(r);
          node.appendChild(tb);
        } else for (const r of chunk) node.appendChild(r);
      }
      if (first && chunk.length < rows.length) for (const r of rows.filter((x) => !chunk.includes(x))) r.remove();
      cur().nodes.push(node);
      first = false;
      chunk = [];
      bodyCount = 0;
    };
    rows.forEach((row, i) => {
      const ids = refsIn(row);
      const bottom = layout.bottom(row);
      const head = first && i < headRows;
      if (chunk.length === 0 && !cur().fresh) {
        // Starting (or continuing) on a page that already holds something: does the first row fit?
        if (!fits(bottom, ids)) next();
      } else if (chunk.length && bodyCount > 0 && !fits(bottom, ids) && !covered.has(i)) {
        flush();
        next();
      }
      if (cur().fresh) {
        cur().fresh = false;
        cur().base = layout.top(row);
        cur().offset = first ? 0 : headH && headRows ? headH : 0;
      }
      addNotes(ids);
      chunk.push(row);
      if (!head) bodyCount++;
    });
    flush();
  };

  blocks.forEach((el, i) => {
    const top = layout.top(el);
    const bottom = layout.bottom(el);
    const ids = refsIn(el);
    if (!cur().fresh && !fits(bottom, ids)) {
      // It does not fit on what is left of the page.
      if (isTable(el) || isList(el)) return split(el as HTMLElement);
      next();
    } else if (!cur().fresh && isHeading(el) && blocks[i + 1]) {
      const after = blocks[i + 1];
      if (!isTable(after) && !isList(after) && !fits(layout.bottom(after), [...ids, ...refsIn(after)])) next();
    }
    if (cur().fresh && (isTable(el) || isList(el)) && bottom - top > cap) return split(el as HTMLElement);
    place(el, top, ids);
  });
  for (const page of pages) if (page.fresh && !page.nodes.length && pages.length > 1) pages.splice(pages.indexOf(page), 1);

  // Build the pages. The first one is the original sheet; the others copy its header, footer and shape.
  const sheetStyle = sheet.getAttribute('style') ?? '';
  const out: HTMLElement[] = [];
  const liveFns = fns;
  pages.forEach((page, n) => {
    const s = n === 0 ? sheet : (sheet.cloneNode(false) as HTMLElement);
    if (n === 0) {
      while (s.firstChild) s.removeChild(s.firstChild);
    } else s.setAttribute('style', sheetStyle);
    const h = n === 0 ? head : (restHead ?? head)?.cloneNode(true);
    const f = n === 0 ? foot : (restFoot ?? foot)?.cloneNode(true);
    for (const x of [h, f]) {
      if (!(x instanceof HTMLElement)) continue;
      x.classList.remove('ck-wp-rest');
      x.style.removeProperty('display');
    }
    if (h) s.appendChild(h);
    const b = body.cloneNode(false) as HTMLElement;
    for (const node of page.nodes) b.appendChild(node);
    s.appendChild(b);
    if (page.notes.length) {
      const box = doc.createElement('div');
      box.className = 'ck-wp-fns';
      const style = liveFns?.getAttribute('style') ?? body.getAttribute('style');
      if (style) box.setAttribute('style', style);
      for (const id of [...page.notes].sort((a, c) => Number(a) - Number(c))) {
        const note = noteEls.get(id);
        if (note) box.appendChild(note);
      }
      s.appendChild(box);
    }
    if (f) s.appendChild(f);
    out.push(s);
  });
  return out;
}

/** Wait for the page's fonts (briefly), so the measuring is done with the fonts the reader will see. */
async function fontsReady(): Promise<void> {
  const fonts = (document as { fonts?: { ready?: Promise<unknown> } }).fonts;
  if (!fonts?.ready) return;
  await Promise.race([fonts.ready, new Promise((r) => setTimeout(r, 400))]);
}

/**
 * The drawn pages of `html` (from `docx-render.ts`, already sanitised) split by height. `mount` is where the hidden
 * copy is laid out; it must sit inside the cockpit so the page styles apply. Returns `html` unchanged when there is
 * nothing to split or something goes wrong.
 */
export async function paginateDocx(html: string, mount: Element = document.body): Promise<string> {
  if (!html.includes('ck-wp-sheet')) return html;
  await fontsReady();
  const holder = document.createElement('div');
  holder.className = 'ck-wp-pages';
  holder.setAttribute('aria-hidden', 'true');
  holder.setAttribute('style', 'position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none');
  holder.innerHTML = html;
  mount.appendChild(holder);
  try {
    const sheets = Array.from(holder.children).filter((c): c is HTMLElement => c instanceof HTMLElement && c.classList.contains('ck-wp-sheet'));
    const result: HTMLElement[][] = sheets.map((s) => paginateSheet(s, document));
    for (const s of sheets) s.remove();
    for (const group of result) for (const s of group) holder.appendChild(s);
    const all = Array.from(holder.querySelectorAll<HTMLElement>('.ck-wp-sheet'));
    all.forEach((s, i) => {
      for (const el of Array.from(s.querySelectorAll('.ck-wp-pageno'))) el.textContent = String(i + 1);
      for (const el of Array.from(s.querySelectorAll('.ck-wp-numpages'))) el.textContent = String(all.length);
      for (const el of Array.from(s.querySelectorAll('.ck-wp-rest'))) el.remove();
    });
    return holder.innerHTML;
  } catch {
    return html;
  } finally {
    holder.remove();
  }
}
