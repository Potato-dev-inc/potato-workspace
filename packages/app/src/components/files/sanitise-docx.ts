// Word text turned into safe HTML. mammoth makes plain HTML from the document; this keeps only page markup
// (headings, lists, tables, pictures written into the page, links) and drops everything that could run or fetch.
import DOMPurify from 'dompurify';

const TAGS = ['p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'strong', 'b', 'em', 'i', 'u', 's', 'sub', 'sup', 'a', 'img', 'blockquote', 'pre', 'code', 'span', 'div'];
const ATTRS = ['href', 'src', 'alt', 'title', 'colspan', 'rowspan', 'id'];
/** Links: web addresses, mail and page anchors. Pictures: only ones written into the page. */
const LINK = /^(?:https?:|mailto:|#)/i;
const PICTURE = /^data:image\/(?:png|jpe?g|gif|bmp|webp);base64,/i;

export function sanitiseDocxHtml(html: string): string {
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
  return body.innerHTML;
}
