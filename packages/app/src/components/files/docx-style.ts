// What a Word document says about looks: text and paragraph properties, the style sheet (with "based on" chains), list
// numbering and table styles. No DOM; reads the small XML tree from `xml-lite.ts`. Only a fixed set of CSS properties
// is ever written, and every value is checked (a colour is six hex digits, a font name has no quotes), so nothing in
// the file can reach the page as markup or a web address.
import { child, kids, val, type XEl } from './xml-lite';

export interface RP {
  b?: boolean;
  i?: boolean;
  u?: boolean;
  strike?: boolean;
  caps?: boolean;
  smallCaps?: boolean;
  hidden?: boolean;
  color?: string;
  /** Points. */
  size?: number;
  font?: string;
  bg?: string;
  sup?: 'super' | 'sub';
}

export interface PP {
  jc?: string;
  indLeft?: number;
  indRight?: number;
  /** Twips; negative is a hanging indent. */
  firstLine?: number;
  before?: number;
  after?: number;
  line?: number;
  lineRule?: string;
  bg?: string;
  top?: string;
  bottom?: string;
  left?: string;
  right?: string;
  numId?: number;
  ilvl?: number;
  pageBreakBefore?: boolean;
}

export interface NumLevel {
  start: number;
  cssType: string;
  indLeft?: number;
}
export interface Num {
  levels: NumLevel[];
}

export interface Borders {
  top?: string;
  bottom?: string;
  left?: string;
  right?: string;
  insideH?: string;
  insideV?: string;
}
export interface TableStyle {
  borders: Borders;
  /** Cell padding in px. */
  mar: { top?: number; bottom?: number; left?: number; right?: number };
  para: PP;
  run: RP;
  firstRow?: { bg?: string; run: RP };
  band1?: string;
  band2?: string;
}

export interface StyleBook {
  paraDefaults: PP;
  runDefaults: RP;
  paraStyle(id: string | undefined): PP;
  /** What a paragraph style says about its text. */
  paraRun(id: string | undefined): RP;
  runStyle(id: string): RP;
  styleName(id: string | undefined): string | undefined;
  numbering(numId: number): Num | undefined;
  tableStyle(id: string | undefined): TableStyle;
}

const HEX = /^[0-9a-f]{6}$/i;
const num = (v: string | undefined) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);
const on = (el: XEl | undefined) => !['0', 'false', 'off'].includes(el?.attrs.val ?? '1');
const colour = (v: string | undefined) => (v && HEX.test(v) ? `#${v}` : undefined);
const FONT_OK = /^[\w .\-\u0080-\uffff]{1,60}$/;

const HIGHLIGHT: Record<string, string> = {
  yellow: '#ffff00',
  green: '#00ff00',
  cyan: '#00ffff',
  magenta: '#ff00ff',
  blue: '#0000ff',
  red: '#ff0000',
  darkBlue: '#000080',
  darkCyan: '#008080',
  darkGreen: '#008000',
  darkMagenta: '#800080',
  darkRed: '#800000',
  darkYellow: '#808000',
  darkGray: '#808080',
  lightGray: '#c0c0c0',
  black: '#000000',
};

function fontStack(names: Array<string | undefined>): string | undefined {
  const good = [...new Set(names.filter((n): n is string => !!n && FONT_OK.test(n)))];
  if (!good.length) return undefined;
  const serif = /times|georgia|serif|ming|song|mincho|cambria|garamond|book/i.test(good[0]) && !/sans/i.test(good[0]);
  return `${good.map((n) => `'${n}'`).join(',')},${serif ? 'serif' : 'sans-serif'}`;
}

export function readRun(r: XEl | undefined): RP {
  const o: RP = {};
  if (!r) return o;
  const b = child(r, 'b');
  if (b) o.b = on(b);
  const i = child(r, 'i');
  if (i) o.i = on(i);
  const u = child(r, 'u');
  if (u) o.u = (u.attrs.val ?? 'single') !== 'none';
  const s = child(r, 'strike') ?? child(r, 'dstrike');
  if (s) o.strike = on(s);
  const caps = child(r, 'caps');
  if (caps) o.caps = on(caps);
  const sc = child(r, 'smallCaps');
  if (sc) o.smallCaps = on(sc);
  const v = child(r, 'vanish');
  if (v) o.hidden = on(v);
  const c = colour(val(r, 'color'));
  if (c) o.color = c;
  const sz = num(val(r, 'sz'));
  if (sz) o.size = sz / 2;
  const f = child(r, 'rFonts');
  const font = fontStack([f?.attrs.ascii ?? f?.attrs.hAnsi, f?.attrs.eastAsia]);
  if (font) o.font = font;
  const hl = val(r, 'highlight');
  const shd = colour(child(r, 'shd')?.attrs.fill);
  if (hl && HIGHLIGHT[hl]) o.bg = HIGHLIGHT[hl];
  else if (shd) o.bg = shd;
  const va = val(r, 'vertAlign');
  if (va === 'superscript') o.sup = 'super';
  else if (va === 'subscript') o.sup = 'sub';
  return o;
}

/** One border as CSS (`1px solid #000`), `none`, or nothing when the element says nothing. */
export function borderCss(el: XEl | undefined): string | undefined {
  if (!el) return undefined;
  const style = el.attrs.val;
  if (!style) return undefined;
  if (style === 'none' || style === 'nil') return 'none';
  const eighths = num(el.attrs.sz) ?? 4;
  const width = Math.max(1, Math.round(eighths / 6));
  const kind = style === 'double' ? 'double' : /dash/i.test(style) ? 'dashed' : /dot/i.test(style) ? 'dotted' : 'solid';
  const w = kind === 'double' ? Math.max(3, width) : width;
  return `${w}px ${kind} ${colour(el.attrs.color) ?? '#000'}`;
}

export function readPara(p: XEl | undefined): PP {
  const o: PP = {};
  if (!p) return o;
  const jc = val(p, 'jc');
  if (jc) o.jc = jc;
  const ind = child(p, 'ind');
  if (ind) {
    const left = num(ind.attrs.left ?? ind.attrs.start);
    const right = num(ind.attrs.right ?? ind.attrs.end);
    if (left !== undefined) o.indLeft = left;
    if (right !== undefined) o.indRight = right;
    const first = num(ind.attrs.firstLine);
    const hang = num(ind.attrs.hanging);
    if (hang !== undefined) o.firstLine = -hang;
    else if (first !== undefined) o.firstLine = first;
  }
  const sp = child(p, 'spacing');
  if (sp) {
    const before = num(sp.attrs.before);
    const after = num(sp.attrs.after);
    const line = num(sp.attrs.line);
    if (before !== undefined) o.before = before;
    if (after !== undefined) o.after = after;
    if (line !== undefined) {
      o.line = line;
      o.lineRule = sp.attrs.lineRule ?? 'auto';
    }
  }
  const shd = colour(child(p, 'shd')?.attrs.fill);
  if (shd) o.bg = shd;
  const bdr = child(p, 'pBdr');
  if (bdr) {
    for (const side of ['top', 'bottom', 'left', 'right'] as const) {
      const css = borderCss(child(bdr, side));
      if (css) o[side] = css;
    }
  }
  const np = child(p, 'numPr');
  if (np) {
    const id = num(val(np, 'numId'));
    if (id !== undefined) o.numId = id;
    const lvl = num(val(np, 'ilvl'));
    if (lvl !== undefined) o.ilvl = lvl;
  }
  if (child(p, 'pageBreakBefore')) o.pageBreakBefore = on(child(p, 'pageBreakBefore'));
  return o;
}

const px = (twips: number) => Math.round((twips / 15) * 100) / 100;

/** The CSS of a run's properties; with `base`, only what differs from it. */
export function runCss(r: RP, base?: RP): string {
  const out: string[] = [];
  const diff = <K extends keyof RP>(k: K) => base === undefined || r[k] !== base[k];
  if (r.font && diff('font')) out.push(`font-family:${r.font}`);
  if (r.size && diff('size')) out.push(`font-size:${r.size}pt`);
  if (r.b !== undefined && diff('b')) out.push(`font-weight:${r.b ? 700 : 400}`);
  if (r.i !== undefined && diff('i')) out.push(`font-style:${r.i ? 'italic' : 'normal'}`);
  if ((r.u !== undefined && diff('u')) || (r.strike !== undefined && diff('strike'))) {
    const d = [r.u ? 'underline' : '', r.strike ? 'line-through' : ''].filter(Boolean).join(' ');
    out.push(`text-decoration:${d || 'none'}`);
  }
  if (r.color && diff('color')) out.push(`color:${r.color}`);
  if (r.bg && diff('bg')) out.push(`background-color:${r.bg}`);
  if (r.caps !== undefined && diff('caps')) out.push(`text-transform:${r.caps ? 'uppercase' : 'none'}`);
  if (r.smallCaps !== undefined && diff('smallCaps')) out.push(`font-variant:${r.smallCaps ? 'small-caps' : 'normal'}`);
  if (r.hidden && diff('hidden')) out.push('display:none');
  if (r.sup && diff('sup')) out.push(`vertical-align:${r.sup}`, 'font-size:smaller');
  return out.join(';');
}

/** The text look a paragraph starts from, as the paragraph's own style (runs only add to it). */
export function paraBaseCss(base: RP): string {
  return runCss(base);
}

export function paraCss(p: PP): string {
  const out: string[] = [];
  if (p.jc) {
    const a = p.jc === 'both' || p.jc === 'distribute' ? 'justify' : p.jc === 'center' ? 'center' : p.jc === 'right' || p.jc === 'end' ? 'right' : 'left';
    out.push(`text-align:${a}`);
  }
  if (p.indLeft !== undefined) out.push(`margin-left:${px(p.indLeft)}px`);
  if (p.indRight !== undefined) out.push(`margin-right:${px(p.indRight)}px`);
  if (p.firstLine !== undefined) out.push(`text-indent:${px(p.firstLine)}px`);
  out.push(`margin-top:${px(p.before ?? 0)}px`, `margin-bottom:${px(p.after ?? 0)}px`);
  if (p.line) {
    if (p.lineRule === 'exact' || p.lineRule === 'atLeast') out.push(`line-height:${px(p.line)}px`);
    else out.push(`line-height:${Math.round((p.line / 240) * 1.17 * 100) / 100}`);
  }
  if (p.bg) out.push(`background-color:${p.bg}`);
  for (const side of ['top', 'bottom', 'left', 'right'] as const) if (p[side]) out.push(`border-${side}:${p[side]}`, ...(p[side] === 'none' ? [] : [`padding-${side}:1px`]));
  return out.join(';');
}

const FORMATS: Record<string, string> = {
  decimal: 'decimal',
  decimalZero: 'decimal-leading-zero',
  lowerLetter: 'lower-alpha',
  upperLetter: 'upper-alpha',
  lowerRoman: 'lower-roman',
  upperRoman: 'upper-roman',
  taiwaneseCounting: 'cjk-ideographic',
  taiwaneseCountingThousand: 'cjk-ideographic',
  chineseCounting: 'cjk-ideographic',
  chineseCountingThousand: 'cjk-ideographic',
  ideographTraditional: 'cjk-ideographic',
  ideographLegalTraditional: 'trad-chinese-formal',
  japaneseCounting: 'japanese-informal',
  none: 'none',
};

function bulletType(text: string | undefined): string {
  const ch = (text ?? '').trim();
  if (!ch || ch === '\uF0B7' || ch === '\uF0D8' || ch === '\uF076') return 'disc';
  if (ch === 'o' || ch === '\uF06F') return 'circle';
  if (ch === '\uF0A7' || ch === '\uF0A8') return 'square';
  // A plain character the document chose (a dash, a box); private-use symbol glyphs fall back to a dot.
  if ([...ch].length === 1 && !/[\uE000-\uF8FF"'\\;{}()]/.test(ch)) return `"${ch} "`;
  return 'disc';
}

function readLevel(l: XEl): NumLevel {
  const fmt = val(l, 'numFmt') ?? 'decimal';
  const lvl: NumLevel = {
    start: num(val(l, 'start')) ?? 1,
    cssType: fmt === 'bullet' ? bulletType(val(l, 'lvlText')) : (FORMATS[fmt] ?? 'decimal'),
  };
  const left = num(child(child(l, 'pPr'), 'ind')?.attrs.left ?? child(child(l, 'pPr'), 'ind')?.attrs.start);
  if (left !== undefined) lvl.indLeft = left;
  return lvl;
}

interface RawStyle {
  id: string;
  type: string;
  name?: string;
  basedOn?: string;
  def: boolean;
  el: XEl;
}

export function createStyles(styles: XEl | undefined, numbering: XEl | undefined): StyleBook {
  const raw = new Map<string, RawStyle>();
  const defaults = child(styles, 'docDefaults');
  const runDefaults = readRun(child(child(defaults, 'rPrDefault'), 'rPr'));
  const paraDefaults = readPara(child(child(defaults, 'pPrDefault'), 'pPr'));
  const defaultPara = { id: '' };
  for (const s of kids(styles, 'style')) {
    const id = s.attrs.styleId;
    if (!id) continue;
    raw.set(id, { id, type: s.attrs.type ?? 'paragraph', name: val(s, 'name'), basedOn: val(s, 'basedOn'), def: s.attrs.default === '1', el: s });
    if (s.attrs.type === 'paragraph' && s.attrs.default === '1') defaultPara.id = id;
  }
  const chain = (id: string | undefined): RawStyle[] => {
    const out: RawStyle[] = [];
    const seen = new Set<string>();
    for (let cur = id ? raw.get(id) : undefined; cur && !seen.has(cur.id); cur = cur.basedOn ? raw.get(cur.basedOn) : undefined) {
      seen.add(cur.id);
      out.unshift(cur);
    }
    return out;
  };
  const merge = <T extends object>(list: RawStyle[], read: (s: RawStyle) => T): T => list.reduce((acc, s) => ({ ...acc, ...read(s) }), {} as T);
  const paraStyle = (id: string | undefined) => merge(chain(id ?? defaultPara.id), (s) => readPara(child(s.el, 'pPr')));
  const paraRun = (id: string | undefined) => merge(chain(id ?? defaultPara.id), (s) => readRun(child(s.el, 'rPr')));

  const abstracts = new Map<string, Map<number, NumLevel>>();
  const nums = new Map<number, string>();
  for (const a of kids(numbering, 'abstractNum')) {
    const levels = new Map<number, NumLevel>();
    for (const l of kids(a, 'lvl')) levels.set(num(l.attrs.ilvl) ?? 0, readLevel(l));
    abstracts.set(a.attrs.abstractNumId ?? '', levels);
  }
  for (const n of kids(numbering, 'num')) {
    const id = num(n.attrs.numId);
    const abs = val(n, 'abstractNumId');
    if (id !== undefined && abs !== undefined) nums.set(id, abs);
  }

  const tableStyle = (id: string | undefined): TableStyle => {
    const ts: TableStyle = { borders: {}, mar: {}, para: {}, run: {} };
    for (const s of chain(id)) {
      const pr = child(s.el, 'tblPr');
      const b = child(pr, 'tblBorders');
      if (b) for (const side of ['top', 'bottom', 'left', 'right', 'insideH', 'insideV'] as const) {
        const css = borderCss(child(b, side) ?? (side === 'left' ? child(b, 'start') : side === 'right' ? child(b, 'end') : undefined));
        if (css) ts.borders[side] = css;
      }
      const m = child(pr, 'tblCellMar');
      if (m) for (const side of ['top', 'bottom', 'left', 'right'] as const) {
        const w = num(child(m, side)?.attrs.w);
        if (w !== undefined) ts.mar[side] = px(w);
      }
      ts.para = { ...ts.para, ...readPara(child(s.el, 'pPr')) };
      ts.run = { ...ts.run, ...readRun(child(s.el, 'rPr')) };
      for (const cond of kids(s.el, 'tblStylePr')) {
        const shd = colour(child(child(cond, 'tcPr'), 'shd')?.attrs.fill);
        const type = cond.attrs.type;
        if (type === 'firstRow') ts.firstRow = { bg: shd ?? ts.firstRow?.bg, run: { ...ts.firstRow?.run, ...readRun(child(cond, 'rPr')) } };
        else if (type === 'band1Horz' && shd) ts.band1 = shd;
        else if (type === 'band2Horz' && shd) ts.band2 = shd;
      }
    }
    return ts;
  };

  return {
    paraDefaults,
    runDefaults,
    paraStyle,
    paraRun,
    runStyle: (id) => merge(chain(id), (s) => readRun(child(s.el, 'rPr'))),
    styleName: (id) => raw.get(id ?? defaultPara.id)?.name,
    numbering: (numId) => {
      const levels = abstracts.get(nums.get(numId) ?? '\u0000');
      if (!levels) return undefined;
      const list: NumLevel[] = [];
      for (let l = 0; l < 9; l++) list[l] = levels.get(l) ?? { start: 1, cssType: 'decimal' };
      return { levels: list };
    },
    tableStyle,
  };
}
