// @vitest-environment jsdom
// Overview > What's new: the "diagnostic file" line opens the review-and-save sheet right there (its Settings row is a developer row).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buttonByText, click, mountRows, settle, type Mounted } from '../test-utils';

vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn(async () => null) }));
vi.mock('../../../lib/tauri', () => ({
  tauri: {
    diagnosticPreview: vi.fn(async () => ({ totalBytes: 10, files: [{ path: 'README.txt', label: 'A short note', bytes: 10 }] })),
    diagnosticShow: vi.fn(async () => ''),
    lastRunStatus: vi.fn(async () => ({ closedUnexpectedly: false, crashedAtMs: null })),
    perfSummary: vi.fn(async () => null),
    diagnosticSave: vi.fn(),
  },
}));

import { generalRows } from '../sections/GeneralSection';

let m: Mounted;
beforeEach(async () => {
  m = await mountRows(generalRows.filter((r) => r.id === 'whats-new'));
});
afterEach(async () => {
  await m.unmount();
});

describe("What's new: the diagnostic line", () => {
  it('opens the diagnostic sheet (review, then save) and Close shuts it', async () => {
    const line = [...m.host.querySelectorAll('.st-labs-item')].find((b) => b.textContent?.includes('diagnostic file'))!;
    expect(line).toBeTruthy();
    await click(line);
    await settle(2);
    const sheet = m.host.querySelector('[data-testid="diagnostic-sheet"]')!;
    expect(sheet).not.toBeNull();
    expect(buttonByText(sheet as HTMLElement, 'Review…')).toBeTruthy();
    await click(buttonByText(sheet as HTMLElement, 'Close')!);
    expect(m.host.querySelector('[data-testid="diagnostic-sheet"]')).toBeNull();
  });
});
