// Word text turned into safe HTML. mammoth makes plain HTML from the document; this keeps only page markup
// (headings, lists, tables, pictures written into the page, links) and drops everything that could run or fetch.
import DOMPurify from 'dompurify';

const TAGS = ['p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'strong', 'b', 'em', 'i', 'u', 's', 'sub', 'sup', 'a', 'img', 'blockquote', 'pre', 'code', 'span', 'div'];
const ATTRS = ['href', 'src', 'alt', 'title', 'colspan', 'rowspan', 'id'];
/** Links: web addresses, mail and page anchors. Pictures: only ones written into the page. */
const LINK = /^(?:https?:|mailto:|#)/i;
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
  const blocks = Array.from(body.children);
  const truncated = blocks.length > maxBlocks;
  if (truncated) for (const extra of blocks.slice(maxBlocks)) extra.remove();
  return { html: body.innerHTML, truncated };
}
