// @vitest-environment jsdom
// Excel files keep their look: fills (also theme colours with a tint), borders, fonts, number formats, merged cells,
// column widths and row heights. Through the real file tab; plain sheets keep the app's table.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileTab } from './FileTab';
import { fakeApi } from './fakes';
import { styledSheetBase64 } from './sheet-look-fixture';
import { XLSX_TWO_SHEETS } from './office-fixtures';
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

async function openSheet(base64: string, name: string) {
  const file: FileBytes = { path: name, name, size: base64.length, kind: 'bytes', base64 };
  const api = fakeApi({}, {}, { [name]: file });
  await act(async () => root.render(<FileTab paneId="p1" path={name} canTell={false} api={api} />));
  for (let i = 0; i < 80 && !host.querySelector('[data-testid="file-sheet"]'); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
  }
  return host.querySelector<HTMLElement>('[data-testid="file-sheet"]')!;
}

describe('an Excel file with its own look', () => {
  it('draws fills, borders, fonts, number formats, merged cells, widths and heights', async () => {
    const sheet = await openSheet(await styledSheetBase64(), 'october.xlsx');
    const table = sheet.querySelector<HTMLElement>('[data-testid="file-sheet-styled"]')!;
    expect(table).not.toBeNull();
    const rows = [...table.querySelectorAll('tr')];
    // The number keeps its format, and its yellow fill, red bold font and double red bottom border.
    const money = rows[1].querySelector('td')!;
    expect(money.textContent).toBe('1,234.50');
    expect(money.style.backgroundColor).toBe('rgb(255, 255, 0)');
    expect(money.style.color).toBe('rgb(255, 0, 0)');
    expect(money.style.fontWeight).toBe('700');
    expect(money.style.borderBottom).toBe('3px double rgb(255, 0, 0)');
    expect(money.style.borderTop).toBe('1px solid rgb(0, 0, 0)');
    expect(money.style.textAlign).toBe('center');
    // A theme colour with a tint becomes the colour Excel shows (light blue).
    const head = rows[0].querySelector('td')!;
    expect(head.style.backgroundColor).toBe('rgb(218, 227, 243)');
    expect(head.style.fontWeight).toBe('700');
    // Merged cells: B1:C1 is one cell across two columns.
    expect([...rows[0].querySelectorAll('td')].map((c) => c.textContent)).toEqual(['Item', 'Merged heading']);
    expect(rows[0].querySelectorAll('td')[1].getAttribute('colspan')).toBe('2');
    // A plain number is on the right; the column and the row have the sizes the file gives.
    expect(rows[1].querySelectorAll('td')[2].style.textAlign).toBe('right');
    expect(table.querySelector('col')?.getAttribute('style')).toContain('width: 120px');
    expect(rows[0].getAttribute('style')).toContain('height: 30px');
  });

  it('keeps the plain table for a sheet with no look, first row as the header', async () => {
    const sheet = await openSheet(XLSX_TWO_SHEETS, 'shop.xlsx');
    expect(sheet.querySelector('[data-testid="file-sheet-styled"]')).toBeNull();
    expect(sheet.querySelector('table.ck-xl-table')).not.toBeNull();
    expect(sheet.querySelectorAll('th').length).toBeGreaterThan(0);
  });
});
