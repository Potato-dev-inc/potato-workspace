// `![alt](path)` is a picture line: the parser only names it; the view asks the PC, which checks the path.
import { describe, expect, it } from 'vitest';
import { parseChatMarkdown } from './chatMarkdown';

const inlines = (text: string) => {
  const block = parseChatMarkdown(text)[0];
  return block && block.kind === 'paragraph' ? block.children : [];
};

describe('picture syntax in the chat text', () => {
  it('reads a plain path and a path in angle brackets (spaces, brackets)', () => {
    expect(inlines('![chart](out/chart.png)')).toEqual([{ kind: 'image', alt: 'chart', path: 'out/chart.png' }]);
    expect(inlines('![a b](<C:/my folder/a (1).png>)')).toEqual([{ kind: 'image', alt: 'a b', path: 'C:/my folder/a (1).png' }]);
  });

  it('keeps the words around it', () => {
    const nodes = inlines('Look: ![x](a.png) done');
    expect(nodes.map((n) => n.kind)).toEqual(['text', 'image', 'text']);
  });

  it('a web address is parsed too (the PC refuses it; the page never loads it)', () => {
    expect(inlines('![x](https://example.com/a.png)')).toEqual([{ kind: 'image', alt: 'x', path: 'https://example.com/a.png' }]);
  });

  it('anything that is not complete picture syntax stays text', () => {
    expect(inlines('Wow! [link](https://x.y)').some((n) => n.kind === 'image')).toBe(false);
    expect(inlines('![broken').some((n) => n.kind === 'image')).toBe(false);
    expect(inlines('![x]()').some((n) => n.kind === 'image')).toBe(false);
    expect(inlines('![x](<unclosed.png)').some((n) => n.kind === 'image')).toBe(false);
  });

  it('never makes HTML: a script in the alt text stays text', () => {
    const [node] = inlines('![<script>alert(1)</script>](a.png)');
    expect(node).toEqual({ kind: 'image', alt: '<script>alert(1)</script>', path: 'a.png' });
  });
});
