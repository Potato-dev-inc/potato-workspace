// One sheet as a table. A plain sheet keeps the app's table look (first row as the header); a sheet that has a look of
// its own in the file (fills, borders, fonts, merged cells, column widths) is drawn like Excel: on a white sheet,
// with those looks, every row a body row. Imported by SheetView only, so it stays in the sheet chunk.
import type { CSSProperties } from 'react';
import type { Sheet } from './sheet-read';

export function SheetTable({ sheet }: { sheet: Sheet }) {
  const look = sheet.look;
  if (!look) {
    return (
      <table className="ck-xl-table">
        <tbody>
          {sheet.rows.map((row, r) => (
            <tr key={r}>{row.map((cell, c) => (r === 0 ? <th key={c}>{cell}</th> : <td key={c}>{cell}</td>))}</tr>
          ))}
        </tbody>
      </table>
    );
  }
  // Cells covered by a merged cell are not drawn; the merged cell spans them.
  const spans = new Map<string, { rows: number; cols: number }>();
  const covered = new Set<string>();
  for (const m of look.merges) {
    spans.set(`${m.r},${m.c}`, m);
    for (let r = m.r; r < m.r + m.rows; r++) for (let c = m.c; c < m.c + m.cols; c++) if (r !== m.r || c !== m.c) covered.add(`${r},${c}`);
  }
  const widths = look.widths;
  return (
    <table className="ck-xl-table is-styled" data-testid="file-sheet-styled">
      {widths.some((w) => w !== null) && (
        <colgroup>
          {widths.map((w, c) => (
            <col key={c} style={w ? { width: w, minWidth: w } : undefined} />
          ))}
        </colgroup>
      )}
      <tbody>
        {sheet.rows.map((row, r) => (
          <tr key={r} style={look.heights[r] ? { height: look.heights[r]! } : undefined}>
            {row.map((cell, c) => {
              if (covered.has(`${r},${c}`)) return null;
              const span = spans.get(`${r},${c}`);
              return (
                <td key={c} colSpan={span && span.cols > 1 ? span.cols : undefined} rowSpan={span && span.rows > 1 ? span.rows : undefined} style={look.styles[r]?.[c] as CSSProperties | undefined}>
                  {cell}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
