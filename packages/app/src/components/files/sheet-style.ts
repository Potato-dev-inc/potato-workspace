// What an Excel file says about how its cells look: fills, borders, fonts, colours (theme colours too), alignment.
// SheetJS (community build) reads values, merged cells and column widths but drops borders and fonts, so this reads
// `xl/styles.xml` and the cell style numbers out of the sheet files itself. No DOM (it runs in the office worker).
// Only a fixed set of CSS properties is written, and every value is built here (hex colours, numbers), never copied.
import { child, kids, parseXml, type XEl } from './xml-lite';

export type CellCss = Record<string, string>;

interface Xf {
  css: CellCss;
  /** The cell sets its own alignment (numbers are otherwise drawn on the right, like Excel). */
  aligned: boolean;
}

const THEME_ORDER = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6'];
const INDEXED = ['000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF'];
const HEX6 = /^[0-9a-f]{6}$/i;

/** Excel's tint: toward white when positive, toward black when negative. */
function tinted(hex: string, tint: number): string {
  const ch = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const out = ch.map((c) => Math.round(tint >= 0 ? c + (255 - c) * tint : c * (1 + tint)));
  return `#${out.map((c) => Math.max(0, Math.min(255, c)).toString(16).padStart(2, '0')).join('')}`;
}

function readTheme(xml: string | null): string[] {
  const out: string[] = [];
  if (!xml) return out;
  const scheme = child(child(parseXml(xml), 'themeElements'), 'clrScheme');
  for (const name of THEME_ORDER) {
    const slot = child(scheme, name);
    const c = slot?.children[0];
    const v = c?.attrs.lastClr ?? c?.attrs.val;
    out.push(v && HEX6.test(v) ? v : name === 'lt1' ? 'FFFFFF' : '000000');
  }
  return out;
}

function colourOf(el: XEl | undefined, theme: string[]): string | undefined {
  if (!el) return undefined;
  const tint = Number(el.attrs.tint ?? 0) || 0;
  let hex: string | undefined;
  if (el.attrs.rgb && /^[0-9a-f]{8}$/i.test(el.attrs.rgb)) hex = el.attrs.rgb.slice(2);
  else if (el.attrs.rgb && HEX6.test(el.attrs.rgb)) hex = el.attrs.rgb;
  else if (el.attrs.theme !== undefined) hex = theme[Number(el.attrs.theme)];
  else if (el.attrs.indexed !== undefined) hex = INDEXED[Number(el.attrs.indexed)];
  else if (el.attrs.auto === '1') hex = '000000';
  if (!hex || !HEX6.test(hex)) return undefined;
  return tint ? tinted(hex, tint) : `#${hex}`;
}

const EDGE: Record<string, string> = {
  thin: '1px solid',
  hair: '1px dotted',
  dotted: '1px dotted',
  dashed: '1px dashed',
  mediumDashed: '2px dashed',
  dashDot: '1px dashed',
  dashDotDot: '1px dashed',
  medium: '2px solid',
  thick: '3px solid',
  double: '3px double',
};

function edge(el: XEl | undefined, theme: string[]): string | undefined {
  const kind = el?.attrs.style;
  if (!kind || !EDGE[kind]) return undefined;
  return `${EDGE[kind]} ${colourOf(child(el, 'color'), theme) ?? '#000000'}`;
}

/** The look of every cell style (`cellXfs`), by number. */
export function readXfs(stylesXml: string, themeXml: string | null): Xf[] {
  const root = parseXml(stylesXml);
  const theme = readTheme(themeXml);
  const fonts = kids(child(root, 'fonts'), 'font');
  const fills = kids(child(root, 'fills'), 'fill');
  const borders = kids(child(root, 'borders'), 'border');
  return kids(child(root, 'cellXfs'), 'xf').map((xf) => {
    const css: CellCss = {};
    const font = fonts[Number(xf.attrs.fontId ?? 0)];
    if (font && Number(xf.attrs.fontId ?? 0) > 0) {
      if (child(font, 'b') && child(font, 'b')?.attrs.val !== '0') css.fontWeight = '700';
      if (child(font, 'i') && child(font, 'i')?.attrs.val !== '0') css.fontStyle = 'italic';
      const u = child(font, 'u');
      const strike = child(font, 'strike');
      const lines = [u && u.attrs.val !== 'none' ? 'underline' : '', strike && strike.attrs.val !== '0' ? 'line-through' : ''].filter(Boolean);
      if (lines.length) css.textDecoration = lines.join(' ');
      const colour = colourOf(child(font, 'color'), theme);
      if (colour) css.color = colour;
      const sz = Number(child(font, 'sz')?.attrs.val);
      if (sz > 0 && sz < 100 && sz !== 11) css.fontSize = `${sz}pt`;
    }
    const fill = fills[Number(xf.attrs.fillId ?? 0)];
    const pattern = child(fill, 'patternFill');
    if (pattern?.attrs.patternType === 'solid') {
      const bg = colourOf(child(pattern, 'fgColor'), theme);
      if (bg) css.backgroundColor = bg;
    }
    const border = borders[Number(xf.attrs.borderId ?? 0)];
    if (border) {
      for (const [side, name] of [['Top', 'top'], ['Bottom', 'bottom'], ['Left', 'left'], ['Right', 'right']] as const) {
        const b = edge(child(border, name), theme);
        if (b) css[`border${side}`] = b;
      }
    }
    const al = child(xf, 'alignment');
    let aligned = false;
    const h = al?.attrs.horizontal;
    if (h === 'center' || h === 'centerContinuous') (css.textAlign = 'center'), (aligned = true);
    else if (h === 'right') (css.textAlign = 'right'), (aligned = true);
    else if (h === 'left') (css.textAlign = 'left'), (aligned = true);
    const v = al?.attrs.vertical;
    // Excel's own default is the bottom of the cell (the sheet's CSS says so), so only the others are written.
    if (v === 'center') css.verticalAlign = 'middle';
    else if (v === 'top') css.verticalAlign = 'top';
    if (al?.attrs.wrapText === '1') (css.whiteSpace = 'pre-wrap'), (css.overflowWrap = 'anywhere');
    // A coloured cell must read on its own: text without a colour of its own is black on the fill.
    if (css.backgroundColor && !css.color) css.color = '#000000';
    return { css, aligned };
  });
}

/** `styles.xml` numbers of the cells (`row,col` → xf number), for the first `maxRow` rows of a sheet file. */
export function cellStyleNumbers(sheetXml: string, maxRow: number): Map<string, number> {
  const out = new Map<string, number>();
  const cut = sheetXml.search(new RegExp(`<row\\b[^>]*\\br="${maxRow + 1}"`));
  const text = cut > 0 ? sheetXml.slice(0, cut) : sheetXml;
  const tag = /<c\b([^>]*?)\/?>/g;
  for (let m = tag.exec(text); m; m = tag.exec(text)) {
    const ref = /\br="([A-Z]{1,3})(\d+)"/.exec(m[1]);
    const s = /\bs="(\d+)"/.exec(m[1]);
    if (!ref || !s || s[1] === '0') continue;
    let col = 0;
    for (const ch of ref[1]) col = col * 26 + ch.charCodeAt(0) - 64;
    out.set(`${Number(ref[2]) - 1},${col - 1}`, Number(s[1]));
  }
  return out;
}

export { type Xf };
