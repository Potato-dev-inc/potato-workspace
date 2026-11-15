// A small XML reader for the parts of a Word or Excel file. It has no DOM, so it runs in the office worker (a worker
// has no DOMParser). Names and attribute names lose their prefix (`w:p` is `p`, `r:id` is `id`); that is enough for
// the few elements the viewers read. Not a general XML parser: no DTDs, no namespaces.

export interface XEl {
  name: string;
  attrs: Record<string, string>;
  children: XEl[];
  /** The text directly inside this element (all text nodes joined). */
  text: string;
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decode(s: string): string {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const local = (n: string) => n.slice(n.indexOf(':') + 1);
const ATTR = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

export function parseXml(src: string): XEl {
  const root: XEl = { name: '#root', attrs: {}, children: [], text: '' };
  const stack: XEl[] = [root];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf('<', i);
    const top = stack[stack.length - 1];
    if (lt < 0) {
      top.text += decode(src.slice(i));
      break;
    }
    if (lt > i) top.text += decode(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end < 0 ? n : end + 3;
    } else if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      top.text += src.slice(lt + 9, end < 0 ? n : end);
      i = end < 0 ? n : end + 3;
    } else if (src[lt + 1] === '?' || src[lt + 1] === '!') {
      const end = src.indexOf('>', lt + 2);
      i = end < 0 ? n : end + 1;
    } else if (src[lt + 1] === '/') {
      const end = src.indexOf('>', lt + 2);
      if (stack.length > 1) stack.pop();
      i = end < 0 ? n : end + 1;
    } else {
      // A tag: find its end, skipping `>` inside quoted attribute values.
      let j = lt + 1;
      let quote = '';
      while (j < n) {
        const c = src[j];
        if (quote) {
          if (c === quote) quote = '';
        } else if (c === '"' || c === "'") quote = c;
        else if (c === '>') break;
        j++;
      }
      const selfClose = src[j - 1] === '/';
      const inner = src.slice(lt + 1, selfClose ? j - 1 : j);
      const sp = inner.search(/[\s]/);
      const rawName = sp < 0 ? inner : inner.slice(0, sp);
      const el: XEl = { name: local(rawName), attrs: {}, children: [], text: '' };
      if (sp >= 0) {
        ATTR.lastIndex = 0;
        for (let m = ATTR.exec(inner); m; m = ATTR.exec(inner)) el.attrs[local(m[1])] = decode(m[2] ?? m[3] ?? '');
      }
      top.children.push(el);
      if (!selfClose) stack.push(el);
      i = j + 1;
    }
  }
  return root.children[0] ?? root;
}

/** The first child called `name`. */
export const child = (el: XEl | undefined, name: string): XEl | undefined => el?.children.find((c) => c.name === name);
export const kids = (el: XEl | undefined, name: string): XEl[] => (el ? el.children.filter((c) => c.name === name) : []);
/** The `val` of a child (`<w:jc w:val="center"/>`). */
export const val = (el: XEl | undefined, name: string): string | undefined => child(el, name)?.attrs.val;
