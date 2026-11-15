// A Word document drawn like Word: pages with real margins, the document's own fonts, sizes, colours, alignment and
// spacing, tables with their borders, shading and widths, headers and footers, page breaks, numbered lists and pictures
// in place. It reads the document's XML itself (no DOM, so it runs in the office worker) and writes HTML with inline
// styles that `sanitise-docx.ts` then filters. Pictures are NOT read here: each is a placeholder `<img id="pmimg-N">`
// whose bytes are read from the file when the screen asks for number N (see `docx-engine.ts`).
// Pages here end where the document says so; `docx-paginate.ts` then splits long pages by measured height (it needs a
// real layout, so it runs in the page, not in the worker). Footnotes and endnotes are written as numbered marks plus
// note blocks; floating pictures and text boxes become floats (approximate: left or right, text wraps around them).
import { child, kids, parseXml, val, type XEl } from './xml-lite';
import { renderTable } from './docx-table';
import {
  createStyles,
  paraBaseCss,
  paraCss,
  readPara,
  readRun,
  runCss,
  type PP,
  type RP,
  type StyleBook,
  type Num,
} from './docx-style';

/** A 1x1 transparent picture: what a photo shows before it is loaded. */
export const PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
export const IMAGE_ID_PREFIX = 'pmimg-';

export type Reader = () => Promise<{ type: string; buffer: ArrayBuffer }>;
export interface DocxSource {
  /** The text of a part of the file (`word/document.xml`), or `null` when the file has none. */
  part(name: string): Promise<string | null>;
  /** The bytes of a picture, from the real file. */
  media(path: string): Promise<ArrayBuffer>;
}
export interface Rendered {
  html: string;
  readers: Reader[];
}

/** A page break in the flow of blocks. */
export const BREAK = Symbol('page-break');
export type Item = string | typeof BREAK;

export interface Ctx {
  /** Where the part's pictures and links are named (`word/_rels/document.xml.rels`). */
  rels: Map<string, { target: string; external: boolean }>;
  /** The folder of the part, for relative picture paths. */
  base: string;
  book: StyleBook;
  readers: Reader[];
  /** Page break and page number only mean something at the top of the page, not in a table. */
  top: boolean;
  page: number;
  pages: number;
  /** Set when a page number was written (so the part cannot be reused on another page). */
  flags: { page: boolean };
  media: (path: string) => Promise<ArrayBuffer>;
  counters: Map<number, number[]>;
  /** Footnotes and endnotes of the document (shared by every part). */
  notes?: NoteBook;
  /** The first section's text width and left margin in px, to tell a left float from a right one. */
  pageBox?: { contentW: number; ml: number };
  /** Inside a table: what its style says about text and paragraphs. */
  tableRun?: RP;
  tablePara?: PP;
}

export interface NoteBook {
  foot: Map<string, XEl>;
  end: Map<string, XEl>;
  /** `f3` / `e1` -> the note's element, in the order they are first used. */
  items: Map<string, XEl>;
  nums: Map<string, number>;
  nf: number;
  ne: number;
}

const roman = (n: number) => {
  const map: Array<[number, string]> = [[10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
  let out = '';
  let rest = n;
  for (const [v, r] of map) {
    while (rest >= v) {
      out += r;
      rest -= v;
    }
  }
  return out || String(n);
};

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const px = (twips: number) => Math.round((twips / 15) * 100) / 100;
const num = (v: string | undefined, d: number) => (v !== undefined && Number.isFinite(Number(v)) ? Number(v) : d);

function mime(path: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1].toLowerCase() ?? '';
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg' || ext === 'jpe') return 'image/jpeg';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'bmp') return 'image/bmp';
  if (ext === 'webp') return 'image/webp';
  return `image/x-${ext || 'unknown'}`;
}

function resolvePath(base: string, target: string): string {
  const parts = target.startsWith('/') ? [] : base.split('/').filter(Boolean);
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

function readRels(xml: string | null): Map<string, { target: string; external: boolean }> {
  const map = new Map<string, { target: string; external: boolean }>();
  if (!xml) return map;
  for (const r of parseXml(xml).children) {
    if (r.name === 'Relationship' && r.attrs.Id) map.set(r.attrs.Id, { target: r.attrs.Target ?? '', external: r.attrs.TargetMode === 'External' });
  }
  return map;
}

function find(el: XEl, name: string): XEl | undefined {
  for (const c of el.children) {
    if (c.name === name) return c;
    const deeper = find(c, name);
    if (deeper) return deeper;
  }
  return undefined;
}

type Side = 'left' | 'right' | 'block';
type Placed = { side: Side; margin: string };

/** Where a floating picture or text box goes: to the left or right of the text, or on a line of its own. */
function placement(anchor: XEl, w: number, ctx: Ctx): Placed {
  const emu = (v: string | undefined) => Math.max(0, Math.round(num(v, 0) / 9525));
  const wrap = anchor.children.find((c) => c.name.startsWith('wrap'))?.name ?? '';
  const pos = child(anchor, 'positionH');
  const align = child(pos, 'align')?.text.trim();
  const offset = Number(child(pos, 'posOffset')?.text);
  const box = ctx.pageBox ?? { contentW: 640, ml: 96 };
  let side: Side = 'left';
  if (align === 'right' || align === 'outside') side = 'right';
  else if (align === 'center') side = 'block';
  else if (Number.isFinite(offset)) {
    const x = offset / 9525 - (pos?.attrs.relativeFrom === 'page' ? box.ml : 0);
    side = x + w / 2 > box.contentW / 2 ? 'right' : 'left';
  }
  if (wrap === 'wrapTopAndBottom') side = 'block';
  const gap = 8;
  const t = emu(anchor.attrs.distT);
  const b = emu(anchor.attrs.distB);
  const l = emu(anchor.attrs.distL);
  const r = emu(anchor.attrs.distR);
  const margin = side === 'right' ? `${t}px ${r}px ${b}px ${Math.max(l, gap)}px` : side === 'left' ? `${t}px ${Math.max(r, gap)}px ${b}px ${l}px` : `${Math.max(t, 4)}px auto ${Math.max(b, 4)}px`;
  return { side, margin };
}

const floatStyle = (p: Placed) => (p.side === 'block' ? `margin:${p.margin}` : `float:${p.side};margin:${p.margin}`);
const floatClass = (p: Placed) => (p.side === 'block' ? 'ck-wp-float ck-wp-fblock' : 'ck-wp-float');

function picture(el: XEl, ctx: Ctx): string {
  let rel: string | undefined;
  let w = 0;
  let h = 0;
  let placed: Placed | undefined;
  if (el.name === 'drawing') {
    const anchor = find(el, 'anchor');
    if (anchor?.attrs.behindDoc === '1') return '';
    rel = find(el, 'blip')?.attrs.embed;
    const ext = find(el, 'extent');
    w = num(ext?.attrs.cx, 0) / 9525;
    h = num(ext?.attrs.cy, 0) / 9525;
    if (anchor) placed = placement(anchor, w, ctx);
  } else {
    rel = find(el, 'imagedata')?.attrs.id;
    const style = find(el, 'shape')?.attrs.style ?? '';
    w = (num(/width:\s*([\d.]+)pt/.exec(style)?.[1], 0) * 96) / 72;
    h = (num(/height:\s*([\d.]+)pt/.exec(style)?.[1], 0) * 96) / 72;
  }
  const target = rel ? ctx.rels.get(rel) : undefined;
  if (!target || target.external) return '';
  const path = resolvePath(ctx.base, target.target);
  const index = ctx.readers.length;
  ctx.readers.push(async () => ({ type: mime(path), buffer: await ctx.media(path) }));
  const size = w > 0 && h > 0 ? `width:${Math.round(w)}px;aspect-ratio:${Math.round(w)}/${Math.round(h)};height:auto;max-width:100%` : 'max-width:100%';
  const own = placed ? `;${floatStyle(placed)}` : '';
  return `<img id="${IMAGE_ID_PREFIX}${index}"${placed ? ` class="${floatClass(placed)}"` : ''} src="${PLACEHOLDER}" alt="" style="${size}${own}">`;
}

const HEX6 = /^[0-9a-f]{6}$/i;

/** A text box (drawing or old-style shape): a bordered box beside the text. Its paragraphs are spans, since a paragraph cannot sit inside a paragraph. */
function textBox(el: XEl, ctx: Ctx): string {
  const content = find(el, 'txbxContent');
  if (!content) return '';
  const anchor = el.name === 'drawing' ? find(el, 'anchor') : undefined;
  if (anchor?.attrs.behindDoc === '1') return '';
  let w = 0;
  let h = 0;
  let placed: Placed | undefined;
  let border = '';
  let fill = '';
  let inset = [4.8, 9.6, 4.8, 9.6];
  if (el.name === 'drawing') {
    const ext = find(el, 'extent');
    w = num(ext?.attrs.cx, 0) / 9525;
    h = num(ext?.attrs.cy, 0) / 9525;
    if (anchor) placed = placement(anchor, w, ctx);
    const sp = find(el, 'spPr');
    const ln = child(sp, 'ln');
    if (ln && !child(ln, 'noFill')) {
      const c = child(child(ln, 'solidFill'), 'srgbClr')?.attrs.val;
      border = `${Math.min(4, Math.max(1, Math.round(num(ln.attrs.w, 9525) / 9525)))}px solid ${c && HEX6.test(c) ? `#${c}` : '#000'}`;
    }
    const f = child(child(sp, 'solidFill'), 'srgbClr')?.attrs.val;
    if (f && HEX6.test(f)) fill = `#${f}`;
    const bp = find(el, 'bodyPr');
    if (bp) inset = [num(bp.attrs.tIns, 45720), num(bp.attrs.rIns, 91440), num(bp.attrs.bIns, 45720), num(bp.attrs.lIns, 91440)].map((v) => Math.round((v / 9525) * 10) / 10);
  } else {
    const shape = find(el, 'shape') ?? find(el, 'rect') ?? find(el, 'roundrect');
    const style = shape?.attrs.style ?? '';
    w = (num(/width:\s*([\d.]+)pt/.exec(style)?.[1], 150) * 96) / 72;
    h = (num(/height:\s*([\d.]+)pt/.exec(style)?.[1], 0) * 96) / 72;
    const side = /mso-position-horizontal:\s*(left|right|center)/.exec(style)?.[1];
    if (/position:\s*absolute/.test(style)) placed = { side: side === 'right' ? 'right' : side === 'center' ? 'block' : 'left', margin: side === 'right' ? '0 0 4px 8px' : side === 'center' ? '4px auto' : '0 8px 4px 0' };
    const stroke = shape?.attrs.strokecolor?.replace('#', '');
    if (shape?.attrs.stroked !== 'f') border = `1px solid ${stroke && HEX6.test(stroke) ? `#${stroke}` : '#000'}`;
    const fc = shape?.attrs.fillcolor?.replace('#', '');
    if (fc && HEX6.test(fc)) fill = `#${fc}`;
  }
  const inner = content.children
    .filter((p) => p.name === 'p')
    .flatMap((p) => paragraph(p, { ...ctx, top: false }, (css, text) => `<span class="ck-wp-boxp" style="${css}">${text || '<br>'}</span>`))
    .filter((i): i is string => typeof i === 'string')
    .join('');
  const style = [
    w > 0 ? `width:${Math.round(w)}px` : '',
    h > 0 ? `min-height:${Math.round(h)}px` : '',
    'max-width:100%',
    'box-sizing:border-box',
    `padding:${inset.map((v) => `${v}px`).join(' ')}`,
    border ? `border:${border}` : '',
    fill ? `background-color:${fill}` : '',
    placed ? floatStyle(placed) : '',
  ]
    .filter(Boolean)
    .join(';');
  const cls = placed ? floatClass(placed) : 'ck-wp-ibox';
  return `<span class="ck-wp-box ${cls}" style="${style}">${inner}</span>`;
}

/** The run children of a paragraph or run, with `mc:AlternateContent` reduced to what Word shows. */
function flat(children: XEl[]): XEl[] {
  const out: XEl[] = [];
  for (const c of children) {
    if (c.name === 'AlternateContent') out.push(...flat(child(c, 'Choice')?.children ?? []));
    else out.push(c);
  }
  return out;
}

interface Field {
  instr: string;
  phase: 'instr' | 'result';
  hide: boolean;
}

/** The inside of a paragraph: runs, links, fields. Page breaks come out as BREAK. */
function inline(children: XEl[], ctx: Ctx, base: RP, fields: Field[], out: Item[]): void {
  for (const node of flat(children)) {
    switch (node.name) {
      case 'r':
        run(node, ctx, base, fields, out);
        break;
      case 'hyperlink': {
        const target = node.attrs.id ? ctx.rels.get(node.attrs.id) : undefined;
        const href = target?.external ? target.target : node.attrs.anchor ? '#' : '';
        const inner: Item[] = [];
        inline(node.children, ctx, base, fields, inner);
        // A link that is not a web or mail address stays as a link without an address (it does nothing when clicked).
        const ok = /^(https?:|mailto:|#)/i.test(href);
        out.push(ok ? `<a href="${esc(href).replace(/"/g, '&quot;')}">` : '<a>', ...inner, '</a>');
        break;
      }
      case 'ins':
      case 'smartTag':
      case 'fldSimple':
      case 'moveTo':
      case 'customXml':
      case 'sdtContent':
        inline(node.children, ctx, base, fields, out);
        break;
      case 'sdt':
        inline(child(node, 'sdtContent')?.children ?? [], ctx, base, fields, out);
        break;
      default:
        break;
    }
  }
}

function run(r: XEl, ctx: Ctx, base: RP, fields: Field[], out: Item[]): void {
  const direct = readRun(child(r, 'rPr'));
  const rs = val(child(r, 'rPr'), 'rStyle');
  const eff: RP = { ...base, ...(rs ? ctx.book.runStyle(rs) : {}), ...direct };
  const css = runCss(eff, base);
  const pieces: string[] = [];
  const hidden = () => fields.some((f) => f.hide);
  for (const c of flat(r.children)) {
    switch (c.name) {
      case 'fldChar': {
        const t = c.attrs.fldCharType;
        if (t === 'begin') fields.push({ instr: '', phase: 'instr', hide: false });
        else if (t === 'separate') {
          const f = fields[fields.length - 1];
          if (f) {
            f.phase = 'result';
            if (/^\s*(PAGE|NUMPAGES)\b/i.test(f.instr)) {
              f.hide = true;
              ctx.flags.page = true;
              pieces.push(/NUMPAGES/i.test(f.instr) ? `<span class="ck-wp-numpages">${ctx.pages}</span>` : `<span class="ck-wp-pageno">${ctx.page}</span>`);
            }
          }
        } else if (t === 'end') fields.pop();
        break;
      }
      case 'instrText': {
        const f = fields[fields.length - 1];
        if (f && f.phase === 'instr') f.instr += c.text;
        break;
      }
      case 't':
        if (!hidden()) pieces.push(esc(c.text));
        break;
      case 'tab':
        if (!hidden()) pieces.push('\t');
        break;
      case 'noBreakHyphen':
        pieces.push('‑');
        break;
      case 'cr':
        pieces.push('<br>');
        break;
      case 'br':
        if (c.attrs.type === 'page') {
          flush(pieces, css, out);
          if (ctx.top) out.push(BREAK);
        } else if (c.attrs.type !== 'column') pieces.push('<br>');
        break;
      case 'drawing':
      case 'pict':
        if (!hidden()) pieces.push(find(c, 'txbxContent') ? textBox(c, ctx) : picture(c, ctx));
        break;
      case 'footnoteReference':
      case 'endnoteReference': {
        const foot = c.name === 'footnoteReference';
        const notes = ctx.notes;
        const id = c.attrs.id ?? '';
        const el = (foot ? notes?.foot : notes?.end)?.get(id);
        if (hidden() || !notes || !el) break;
        const key = `${foot ? 'f' : 'e'}${id}`;
        let n = notes.nums.get(key);
        if (n === undefined) {
          n = foot ? ++notes.nf : ++notes.ne;
          notes.nums.set(key, n);
          notes.items.set(`${foot ? 'f' : 'e'}${n}`, el);
        }
        pieces.push(`<sup class="ck-wp-fnref" id="${foot ? 'fnref' : 'enref'}-${n}">${foot ? n : roman(n)}</sup>`);
        break;
      }
      default:
        break;
    }
  }
  flush(pieces, css, out);
}

function flush(pieces: string[], css: string, out: Item[]): void {
  if (!pieces.length) return;
  const html = pieces.join('');
  pieces.length = 0;
  out.push(css ? `<span style="${css}">${html}</span>` : html);
}

const HEADING = /^(?:heading|標題)\s*([1-6])$/i;

function numberOf(pp: PP, ctx: Ctx): { num: Num; level: number; value: number } | null {
  if (!pp.numId) return null;
  const n = ctx.book.numbering(pp.numId);
  if (!n) return null;
  const level = Math.max(0, Math.min(8, pp.ilvl ?? 0));
  let counts = ctx.counters.get(pp.numId);
  if (!counts) ctx.counters.set(pp.numId, (counts = []));
  const start = (l: number) => n.levels[l]?.start ?? 1;
  counts[level] = (counts[level] ?? start(level) - 1) + 1;
  for (let l = level + 1; l < 9; l++) delete counts[l];
  return { num: n, level, value: counts[level] };
}

function paragraph(p: XEl, ctx: Ctx, forList?: (css: string, inner: string, pp: PP) => string): Item[] {
  const pPr = child(p, 'pPr');
  const style = val(pPr, 'pStyle');
  const pp: PP = { ...ctx.book.paraDefaults, ...ctx.tablePara, ...ctx.book.paraStyle(style), ...readPara(pPr) };
  const base: RP = { ...ctx.book.runDefaults, ...ctx.tableRun, ...ctx.book.paraRun(style) };
  const parts: Item[] = [];
  inline(p.children, ctx, base, [], parts);
  const css = [paraBaseCss(base), paraCss(pp)].filter(Boolean).join(';');
  const name = ctx.book.styleName(style);
  const heading = HEADING.exec(name ?? '')?.[1];
  const tag = heading ? `h${heading}` : 'p';
  // Split at page breaks: the text before a break is one paragraph, the text after it the next.
  const make = (inner: string) => (forList ? forList(css, inner, pp) : `<${tag} style="${css}">${inner || '<br>'}</${tag}>`);
  const result: Item[] = [];
  if (pp.pageBreakBefore && ctx.top) result.push(BREAK);
  let cur: string[] = [];
  let broke = false;
  for (const part of parts) {
    if (part !== BREAK) cur.push(part);
    else {
      broke = true;
      if (cur.length) result.push(make(cur.join('')));
      result.push(BREAK);
      cur = [];
    }
  }
  if (cur.length || !broke) result.push(make(cur.join('')));
  return result;
}

/** Blocks (paragraphs, tables, content controls) as HTML items. */
export function blocks(children: XEl[], ctx: Ctx): Item[] {
  const out: Item[] = [];
  let list: string[] | null = null;
  const closeList = () => {
    if (list) out.push(`<ul class="ck-wp-list">${list.join('')}</ul>`);
    list = null;
  };
  const items = (els: XEl[]) => {
    for (const el of els) {
      if (el.name === 'sdt') items(child(el, 'sdtContent')?.children ?? []);
      else if (el.name === 'AlternateContent') items(flat([el]));
      else if (el.name === 'tbl') {
        closeList();
        out.push(renderTable(el, ctx, blocks));
      } else if (el.name === 'p') {
        const pp: PP = { ...ctx.book.paraDefaults, ...ctx.book.paraStyle(val(child(el, 'pPr'), 'pStyle')), ...readPara(child(el, 'pPr')) };
        const n = numberOf(pp, ctx);
        if (n) {
          const made = paragraph(el, ctx, (css, inner, p2) => {
            const lvl = n.num.levels[n.level];
            const indent = p2.indLeft ?? lvl?.indLeft ?? 0;
            const type = lvl?.cssType ?? 'decimal';
            const own = [`list-style-type:${type}`, `margin-left:${px(indent)}px`, css].filter(Boolean).join(';');
            return `<li value="${n.value}" style="${own}">${inner || '<br>'}</li>`;
          });
          for (const it of made) {
            if (it === BREAK) {
              closeList();
              out.push(BREAK);
            } else (list ??= []).push(it);
          }
        } else {
          closeList();
          out.push(...paragraph(el, ctx));
        }
      }
    }
  };
  items(children);
  closeList();
  return out;
}

interface Sec {
  w: number;
  h: number;
  mt: number;
  mb: number;
  ml: number;
  mr: number;
  hd: number;
  fd: number;
  titlePg: boolean;
  continuous: boolean;
  header: Record<string, string>;
  footer: Record<string, string>;
}

function readSec(el: XEl | undefined, before?: Sec): Sec {
  const size = child(el, 'pgSz');
  const mar = child(el, 'pgMar');
  const refs = (name: string, inherited?: Record<string, string>) => {
    const own: Record<string, string> = {};
    for (const r of kids(el, name)) if (r.attrs.type && r.attrs.id) own[r.attrs.type] = r.attrs.id;
    return Object.keys(own).length ? own : (inherited ?? {});
  };
  return {
    w: px(num(size?.attrs.w, 11906)),
    h: px(num(size?.attrs.h, 16838)),
    mt: px(num(mar?.attrs.top, 1440)),
    mb: px(num(mar?.attrs.bottom, 1440)),
    ml: px(num(mar?.attrs.left, 1440)),
    mr: px(num(mar?.attrs.right, 1440)),
    hd: px(num(mar?.attrs.header, 720)),
    fd: px(num(mar?.attrs.footer, 720)),
    titlePg: !!child(el, 'titlePg'),
    continuous: val(el, 'type') === 'continuous',
    header: refs('headerReference', before?.header),
    footer: refs('footerReference', before?.footer),
  };
}

interface Sheet {
  sec: Sec;
  items: string[];
  firstOfSection: boolean;
  /** Numbers of the footnotes whose mark is on this page. */
  notes: number[];
}

const FOOT_REF = /id="fnref-(\d+)"/g;

function noteMap(xml: string | null, name: string): Map<string, XEl> {
  const map = new Map<string, XEl>();
  if (!xml) return map;
  for (const n of kids(parseXml(xml), name)) {
    const type = n.attrs.type;
    if (n.attrs.id !== undefined && (!type || type === 'normal')) map.set(n.attrs.id, n);
  }
  return map;
}

/** The document as pages. Throws when the file is not a Word document (the caller then falls back). */
export async function renderWord(src: DocxSource): Promise<Rendered> {
  const docXml = await src.part('word/document.xml');
  if (!docXml) throw new Error('no document');
  const readers: Reader[] = [];
  const [stylesXml, numberingXml, relsXml, footXml, endXml] = await Promise.all([
    src.part('word/styles.xml'),
    src.part('word/numbering.xml'),
    src.part('word/_rels/document.xml.rels'),
    src.part('word/footnotes.xml'),
    src.part('word/endnotes.xml'),
  ]);
  const notes: NoteBook = { foot: noteMap(footXml, 'footnote'), end: noteMap(endXml, 'endnote'), items: new Map(), nums: new Map(), nf: 0, ne: 0 };
  const book = createStyles(stylesXml ? parseXml(stylesXml) : undefined, numberingXml ? parseXml(numberingXml) : undefined);
  const rels = readRels(relsXml);
  const body = child(parseXml(docXml), 'body');
  if (!body) throw new Error('no body');
  const ctx: Ctx = { rels, base: 'word', book, readers, top: true, page: 1, pages: 1, flags: { page: false }, media: src.media, counters: new Map(), notes };

  // Sections: every paragraph with section properties ends one; the body's own ends the last.
  const secEls: XEl[] = [];
  for (const el of body.children) {
    const sp = el.name === 'p' ? child(child(el, 'pPr'), 'sectPr') : undefined;
    if (sp) secEls.push(sp);
  }
  const last = child(body, 'sectPr');
  if (last) secEls.push(last);
  const secs: Sec[] = [];
  for (const el of secEls.length ? secEls : [undefined]) secs.push(readSec(el, secs[secs.length - 1]));

  ctx.pageBox = { contentW: secs[0].w - secs[0].ml - secs[0].mr, ml: secs[0].ml };
  const sheets: Sheet[] = [{ sec: secs[0], items: [], firstOfSection: true, notes: [] }];
  let k = 0;
  const startSheet = (sec: Sec, first: boolean) => sheets.push({ sec, items: [], firstOfSection: first, notes: [] });
  const chunk: XEl[] = [];
  const place = () => {
    for (const it of blocks(chunk, ctx)) {
      if (it === BREAK) {
        if (sheets[sheets.length - 1].items.length) startSheet(secs[k], false);
      } else {
        const sheet = sheets[sheets.length - 1];
        sheet.items.push(it);
        for (const m of it.matchAll(FOOT_REF)) sheet.notes.push(Number(m[1]));
      }
    }
    chunk.length = 0;
  };
  for (const el of body.children) {
    chunk.push(el);
    if (el.name === 'p' && child(child(el, 'pPr'), 'sectPr')) {
      place();
      k = Math.min(k + 1, secs.length - 1);
      if (!secs[k].continuous) startSheet(secs[k], true);
    }
  }
  place();
  while (sheets.length > 1 && !sheets[sheets.length - 1].items.length) sheets.pop();

  // Endnotes go after the last page's text, as ordinary blocks (they split across pages like the rest).
  const lastSheet = sheets[sheets.length - 1];
  const endCount = notes.ne;
  const noteRels = new Map<string, Map<string, { target: string; external: boolean }>>();
  const noteHtml = async (kind: 'f' | 'e', n: number): Promise<string> => {
    const el = notes.items.get(`${kind}${n}`);
    if (!el) return '';
    const file = kind === 'f' ? 'footnotes' : 'endnotes';
    if (!noteRels.has(file)) noteRels.set(file, readRels(await src.part(`word/_rels/${file}.xml.rels`)));
    const sub: Ctx = { ...ctx, rels: noteRels.get(file) ?? rels, top: false, counters: new Map() };
    const inner = blocks(el.children, sub).filter((i): i is string => typeof i === 'string').join('');
    const mark = `<sup class="ck-wp-fnmark">${kind === 'f' ? n : roman(n)}</sup> `;
    const text = /^<p[^>]*>/.test(inner) ? inner.replace(/^(<p[^>]*>)/, `$1${mark}`) : mark + inner;
    return `<div class="ck-wp-fn" id="${kind === 'f' ? 'fn' : 'en'}-${n}">${text}</div>`;
  };
  if (endCount) {
    lastSheet.items.push('<div class="ck-wp-enrule"></div>');
    for (let n = 1; n <= endCount; n++) lastSheet.items.push(await noteHtml('e', n));
  }

  const total = sheets.length;
  const cache = new Map<string, string>();
  const partHtml = async (id: string | undefined, page: number): Promise<string> => {
    const target = id ? rels.get(id)?.target : undefined;
    if (!target) return '';
    const path = resolvePath('word', target);
    const hit = cache.get(path);
    if (hit !== undefined) return hit;
    const xml = await src.part(path);
    if (!xml) return '';
    const dir = path.slice(0, path.lastIndexOf('/'));
    const partRels = readRels(await src.part(`${dir}/_rels/${path.slice(path.lastIndexOf('/') + 1)}.rels`));
    const sub: Ctx = { ...ctx, rels: partRels, base: dir, top: false, page, pages: total, flags: { page: false }, counters: new Map() };
    const html = blocks(parseXml(xml).children, sub).filter((i): i is string => typeof i === 'string').join('');
    if (!sub.flags.page) cache.set(path, html);
    return html;
  };

  const out: string[] = [];
  for (let n = 0; n < sheets.length; n++) {
    const { sec, items, firstOfSection } = sheets[n];
    const kind = sec.titlePg && firstOfSection ? 'first' : 'default';
    const head = await partHtml(sec.header[kind], n + 1);
    const foot = await partHtml(sec.footer[kind], n + 1);
    const headStyle = `padding:${sec.hd}px ${sec.mr}px 0 ${sec.ml}px;min-height:${sec.mt}px`;
    const footStyle = `padding:0 ${sec.mr}px ${sec.fd}px ${sec.ml}px;min-height:${sec.mb}px`;
    // A page that follows an automatic split uses the ordinary header and footer, not the first-page ones.
    const rest =
      kind === 'first'
        ? `<div class="ck-wp-head ck-wp-rest" style="display:none;${headStyle}">${await partHtml(sec.header.default, n + 1)}</div>`
        : '';
    const restFoot = kind === 'first' ? `<div class="ck-wp-foot ck-wp-rest" style="display:none;${footStyle}">${await partHtml(sec.footer.default, n + 1)}</div>` : '';
    const mine = [...new Set(sheets[n].notes)].sort((a, b) => a - b);
    const noteBlock = mine.length ? `<div class="ck-wp-fns" style="padding:0 ${sec.mr}px 0 ${sec.ml}px">${(await Promise.all(mine.map((m) => noteHtml('f', m)))).join('')}</div>` : '';
    out.push(
      `<div class="ck-wp-sheet" style="width:${sec.w}px;min-height:${sec.h}px">` +
        `<div class="ck-wp-head" style="${headStyle}">${head}</div>${rest}` +
        `<div class="ck-wp-body" style="padding:0 ${sec.mr}px 0 ${sec.ml}px">${items.join('')}</div>` +
        noteBlock +
        `<div class="ck-wp-foot" style="${footStyle}">${foot}</div>${restFoot}` +
        '</div>',
    );
  }
  return { html: out.join(''), readers };
}
