// UX-9: every row can be found by its keywords, and search results name the section.
import { describe, expect, it } from 'vitest';
import { SECTIONS } from './catalog';
import { searchSections } from './model';

const allRows = SECTIONS.flatMap((s) => s.rows.map((r) => ({ section: s, row: r })));

describe('settings search keywords', () => {
  it('every catalog section has at least one row with keywords', () => {
    for (const section of SECTIONS) {
      const withKeywords = section.rows.filter((r) => (r.keywords ?? '').trim() !== '');
      expect(withKeywords.length, section.id).toBeGreaterThan(0);
    }
  });

  it('every row has keywords', () => {
    const missing = allRows.filter(({ row }) => !row.pointer && (row.keywords ?? '').trim() === '').map(({ section, row }) => `${section.id}/${row.id}`);
    expect(missing).toEqual([]);
  });

  it('"key" finds the provider key rows, under Keys', () => {
    const hits = searchSections(SECTIONS, 'key');
    const keys = hits.find((h) => h.section.id === 'keys');
    expect(keys?.rows.map((r) => r.id)).toEqual(expect.arrayContaining(['key-anthropic', 'key-openai', 'key-openrouter']));
  });

  it('"chat add-on" finds its row', () => {
    const addon = searchSections(SECTIONS, 'chat add-on').flatMap((h) => h.rows.map((r) => r.id));
    expect(addon).toContain('chat-addons');
  });
});
