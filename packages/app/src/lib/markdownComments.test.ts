import { describe, expect, it } from 'vitest';
import { stripHtmlComments } from './markdownComments';

describe('stripHtmlComments', () => {
  it('leaves only the bullet of the memory block', () => {
    const t = '<!-- a:start -->\n<!-- Managed by x. -->\n- n\n<!-- a:end -->\n';
    expect(stripHtmlComments(t).trim()).toBe('- n');
  });
  it('removes a comment over several lines and one inside a line', () => {
    expect(stripHtmlComments('a <!-- x --> b\n<!-- one\ntwo -->\nc')).toBe('a  b\nc');
  });
  it('keeps comments in fenced code and in inline code', () => {
    const t = '```html\n<!-- keep -->\n```\nuse `<!-- keep -->` here';
    expect(stripHtmlComments(t)).toBe(t);
  });
  it('an unclosed comment hides the rest', () => {
    expect(stripHtmlComments('a\n<!-- never closed\nb')).toBe('a');
  });
  it('text with no comment is returned as is', () => {
    expect(stripHtmlComments('x --> y')).toBe('x --> y');
  });
});
