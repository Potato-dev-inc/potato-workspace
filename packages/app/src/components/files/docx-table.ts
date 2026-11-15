// Word tables as HTML tables: column widths from the grid, borders (the table's, its style's and each cell's own),
// shading, merged cells (across and down), cell padding, row heights, the first-row and banded-row looks of a table
// style. The block renderer comes in as a parameter, so a cell can hold paragraphs or another table.
import type { Ctx, Item } from './docx-render';
import { borderCss, type Borders } from './docx-style';
import { child, kids, val, type XEl } from './xml-lite';

type Blocks = (children: XEl[], ctx: Ctx) => Item[];

const px = (twips: number) => Math.round((twips / 15) * 100) / 100;
const num = (v: string | undefined) => (v !== undefined && Number.isFinite(Number(v)) ? Number(v) : undefined);
const colour = (v: string | undefined) => (v && /^[0-9a-f]{6}$/i.test(v) ? `#${v}` : undefined);

interface Cell {
  el: XEl;
  row: number;
  col: number;
  span: number;
  rowspan: number;
  continued: boolean;
}

function sides(el: XEl | undefined): Borders {
  const out: Borders = {};
  if (!el) return out;
  for (const side of ['top', 'bottom', 'left', 'right', 'insideH', 'insideV'] as const) {
    const alias = side === 'left' ? 'start' : side === 'right' ? 'end' : undefined;
    const css = borderCss(child(el, side) ?? (alias ? child(el, alias) : undefined));
    if (css) out[side] = css;
  }
  return out;
}

export function renderTable(tbl: XEl, ctx: Ctx, blocks: Blocks): string {
  const pr = child(tbl, 'tblPr');
  const st = ctx.book.tableStyle(val(pr, 'tblStyle'));
  const borders: Borders = { ...st.borders, ...sides(child(pr, 'tblBorders')) };
  const mar = { left: 7.2, right: 7.2, top: 0, bottom: 0, ...st.mar };
  const cellMar = child(pr, 'tblCellMar');
  for (const side of ['top', 'bottom', 'left', 'right'] as const) {
    const w = num(child(cellMar, side)?.attrs.w ?? child(cellMar, side === 'left' ? 'start' : side === 'right' ? 'end' : side)?.attrs.w);
    if (w !== undefined) mar[side] = px(w);
  }
  const look = child(pr, 'tblLook');
  // Without a "look" element a table style adds nothing; with one, its flags say which parts of the style apply.
  const mask = look?.attrs.val ? parseInt(look.attrs.val, 16) : 0;
  const firstRowOn = !!look && (look.attrs.firstRow !== undefined ? look.attrs.firstRow === '1' : (mask & 0x20) !== 0);
  const bandsOn = !!look && (look.attrs.noHBand !== undefined ? look.attrs.noHBand !== '1' : (mask & 0x200) === 0);

  const grid = kids(child(tbl, 'tblGrid'), 'gridCol').map((g) => px(num(g.attrs.w) ?? 0));
  const rows = kids(tbl, 'tr');
  // Place cells on the grid; a "continue" cell in a vertical merge adds to the cell above it.
  const placed: Cell[][] = [];
  const open = new Map<number, Cell>();
  let columns = grid.length;
  rows.forEach((tr, r) => {
    const list: Cell[] = [];
    let col = num(val(child(tr, 'trPr'), 'gridBefore')) ?? 0;
    for (const tc of kids(tr, 'tc')) {
      const tcPr = child(tc, 'tcPr');
      const span = Math.max(1, num(val(tcPr, 'gridSpan')) ?? 1);
      const vm = child(tcPr, 'vMerge');
      const cell: Cell = { el: tc, row: r, col, span, rowspan: 1, continued: !!vm && vm.attrs.val !== 'restart' };
      if (cell.continued) {
        const origin = open.get(col);
        if (origin) origin.rowspan++;
        else cell.continued = false;
      } else if (vm) open.set(col, cell);
      else for (let c = col; c < col + span; c++) open.delete(c);
      list.push(cell);
      col += span;
    }
    columns = Math.max(columns, col);
    placed.push(list);
  });

  const widthOf = (c: number, span: number) => grid.slice(c, c + span).reduce((a, b) => a + b, 0);
  const total = widthOf(0, columns);
  const tw = child(pr, 'tblW');
  const twType = tw?.attrs.type;
  const twVal = num(tw?.attrs.w);
  const width = twType === 'pct' && twVal !== undefined ? `${Math.min(100, twVal / 50)}%` : twType === 'dxa' && twVal ? `${px(twVal)}px` : total ? `${total}px` : '100%';
  const jc = val(pr, 'jc');
  const ind = num(child(pr, 'tblInd')?.attrs.w);
  const tableCss = [
    `width:${width}`,
    'max-width:none',
    'border-collapse:collapse',
    'table-layout:fixed',
    jc === 'center' ? 'margin:0 auto' : jc === 'right' || jc === 'end' ? 'margin-left:auto' : ind ? `margin-left:${px(ind)}px` : '',
    'align-self:flex-start',
  ]
    .filter(Boolean)
    .join(';');

  const out: string[] = [`<table class="ck-wp-tbl" style="${tableCss}">`];
  if (grid.length) out.push('<colgroup>', ...grid.map((w) => `<col style="width:${w}px">`), '</colgroup>');
  out.push('<tbody>');
  placed.forEach((list, r) => {
    const trPr = child(rows[r], 'trPr');
    const h = child(trPr, 'trHeight');
    const height = num(h?.attrs.val);
    const before = num(val(trPr, 'gridBefore')) ?? 0;
    out.push(`<tr${height ? ` style="height:${px(height)}px"` : ''}>`);
    if (before) out.push(`<td colspan="${before}" style="border:none"></td>`);
    const head = firstRowOn && r === 0 && st.firstRow;
    const band = bandsOn ? ((r - (firstRowOn && st.firstRow ? 1 : 0)) % 2 === 0 ? st.band1 : st.band2) : undefined;
    for (const cell of list) {
      if (cell.continued) continue;
      const tcPr = child(cell.el, 'tcPr');
      const mine = sides(child(tcPr, 'tcBorders'));
      const lastRow = r + cell.rowspan >= rows.length;
      const lastCol = cell.col + cell.span >= columns;
      const edge: Record<'top' | 'bottom' | 'left' | 'right', string | undefined> = {
        top: mine.top ?? (r === 0 ? borders.top : borders.insideH),
        bottom: mine.bottom ?? (lastRow ? borders.bottom : borders.insideH),
        left: mine.left ?? (cell.col === 0 ? borders.left : borders.insideV),
        right: mine.right ?? (lastCol ? borders.right : borders.insideV),
      };
      const fill = colour(child(tcPr, 'shd')?.attrs.fill) ?? (head ? head.bg : undefined) ?? band;
      const va = val(tcPr, 'vAlign');
      const css = [
        ...(['top', 'bottom', 'left', 'right'] as const).map((s) => (edge[s] ? `border-${s}:${edge[s]}` : '')),
        `padding:${mar.top}px ${mar.right}px ${mar.bottom}px ${mar.left}px`,
        fill ? `background-color:${fill}` : '',
        va === 'center' ? 'vertical-align:middle' : va === 'bottom' ? 'vertical-align:bottom' : 'vertical-align:top',
        'overflow-wrap:anywhere',
      ]
        .filter(Boolean)
        .join(';');
      const inner: Ctx = { ...ctx, top: false, tableRun: { ...st.run, ...(head ? head.run : {}) }, tablePara: st.para };
      const content = blocks(cell.el.children, inner).filter((i): i is string => typeof i === 'string').join('');
      out.push(`<td${cell.span > 1 ? ` colspan="${cell.span}"` : ''}${cell.rowspan > 1 ? ` rowspan="${cell.rowspan}"` : ''} style="${css}">${content}</td>`);
    }
    out.push('</tr>');
  });
  out.push('</tbody></table>');
  return out.join('');
}
