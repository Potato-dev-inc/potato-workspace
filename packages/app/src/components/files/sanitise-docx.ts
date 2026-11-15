// Word text turned into safe HTML. mammoth makes plain HTML from the document; this keeps only page markup
// (headings, lists, tables, pictures written into the page, links) and drops everything that could run or fetch.
import DOMPurify from 'dompurify';

const TAGS = ['p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'strong', 'b', 'em', 'i', 'u', 's', 'sub', 'sup', 'a', 'img', 'blockquote', 'pre', 'code', 'span', 'div', 'colgroup', 'col'];
const ATTRS = ['href', 'src', 'alt', 'title', 'colspan', 'rowspan', 'id', 'style', 'class', 'value'];
/** Links: web addresses, mail and page anchors. Pictures: only ones written into the page. */
const LINK = /^(?:https?:|mailto:|#)/i;
/** The only CSS the page keeps (the document viewer writes these and nothing else). */
const CSS_PROPS = new Set([
  'width', 'height', 'min-height', 'max-width', 'aspect-ratio', 'margin', 'margin-top', 'margin-bottom', 'margin-left', 'margin-right',
  'padding', 'padding-top', 'padding-bottom', 'padding-left', 'padding-right', 'text-align', 'text-indent', 'line-height',
  'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant', 'text-decoration', 'text-transform', 'color',
  'background-color', 'vertical-align', 'border', 'border-top', 'border-bottom', 'border-left', 'border-right', 'table-layout',
  'border-collapse', 'list-style-type', 'overflow-wrap', 'align-self', 'display',
]);
/** A value may not fetch, escape or nest anything. */
const CSS_VALUE = /^[\w\s.,%#"'\-\u0080-￿/]*$/;

/** `style` text cut down to the known properties with plain values; `display` may only hide. */
export function safeStyle(style: string): string {
  const kept: string[] = [];
  for (const decl of style.split(';')) {
    const at = decl.indexOf(':');
    if (at < 0) continue;
    const prop = decl.slice(0, at).trim().toLowerCase();
    const value = decl.slice(at + 1).trim();
    if (!CSS_PROPS.has(prop) || !CSS_VALUE.test(value) || /url|expression|import/i.test(value)) continue;
    if (prop === 'display' && value !== 'none') continue;
    kept.push(`${prop}:${value}`);
  }
  return kept.join(';');
}

const PICTURE = /^data:image\/(?:png|jpe?g|gif|bmp|webp);base64,/i;

/** Past this many top-level blocks (paragraphs, tables, lists) only the first part of a document is shown. */
export const DOCX_BLOCK_CAP = 2500;

export function sanitiseDocxHtml(html: string): string {
  return sanitiseDocxPage(html, Infinity).html;
}

/** The same, cut after `maxBlocks` top-level blocks. `truncated` is true when something was cut. */
export function sanitiseDocxPage(html: string, maxBlocks: number): { html: string; truncated: boolean } {
  const body = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: TAGS,
    ALLOWED_ATTR: ATTRS,
    ALLOW_DATA_ATTR: false,
    ADD_URI_SAFE_ATTR: ['colspan', 'rowspan', 'value'],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#|data:image\/)/i,
    RETURN_DOM: true,
  }) as HTMLElement;
  for (const a of Array.from(body.querySelectorAll('a'))) {
    const href = a.getAttribute('href') ?? '';
    if (!LINK.test(href)) a.removeAttribute('href');
    a.setAttribute('rel', 'noopener noreferrer');
  }
  for (const img of Array.from(body.querySelectorAll('img'))) {
    if (!PICTURE.test(img.getAttribute('src') ?? '')) img.remove();
  }
  for (const el of Array.from(body.querySelectorAll('[style]'))) {
    const clean = safeStyle(el.getAttribute('style') ?? '');
    if (clean) el.setAttribute('style', clean);
    else el.removeAttribute('style');
  }
  for (const el of Array.from(body.querySelectorAll('[class]'))) {
    const keep = (el.getAttribute('class') ?? '').split(/\s+/).filter((c) => c.startsWith('ck-wp-'));
    if (keep.length) el.setAttribute('class', keep.join(' '));
    else el.removeAttribute('class');
  }
  for (const el of Array.from(body.querySelectorAll('[value]'))) if (!/^\d{1,6}$/.test(el.getAttribute('value') ?? '')) el.removeAttribute('value');
  // Drawn pages: the cap counts the blocks inside the pages, not the pages.
  const inPages = Array.from(body.querySelectorAll('.ck-wp-body'));
  if (inPages.length) {
    let seen = 0;
    let cut = false;
    for (const page of inPages) {
      for (const el of Array.from(page.children)) {
        if (++seen > maxBlocks) {
          el.remove();
          cut = true;
        }
      }
    }
    return { html: body.innerHTML, truncated: cut };
  }
  const blocks = Array.from(body.children);
  const truncated = blocks.length > maxBlocks;
  if (truncated) for (const extra of blocks.slice(maxBlocks)) extra.remove();
  return { html: body.innerHTML, truncated };
}
