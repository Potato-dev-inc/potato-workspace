// A page shown in a locked-down frame: no access to the app, its storage or its commands. It is the one place the
// app shows HTML it did not write (an .html file, later an Artifact). The frame has an opaque origin (never
// `allow-same-origin`), cannot navigate the app, open windows, submit forms or reach the network (the policy inside
// the page allows only pictures and styles that are written into it).
import { useMemo } from 'react';

/** The only addresses a page may load a script, style or font from (and only with `cdn`). Fixed, short, no wildcards. */
export const CDN_HOSTS = ['https://cdnjs.cloudflare.com', 'https://cdn.jsdelivr.net', 'https://unpkg.com'] as const;

export interface SandboxOptions {
  /** Let the page run its own scripts (still with no app access, no network). Off by default. */
  allowScripts?: boolean;
  /** Let the page load scripts, styles and fonts from the short CDN list (`CDN_HOSTS`). Needs `allowScripts` to matter; off by default. */
  cdn?: boolean;
}

/** The `sandbox` attribute: never same-origin, top navigation, popups, forms or downloads. */
export function sandboxAttribute({ allowScripts = false }: SandboxOptions = {}): string {
  return allowScripts ? 'allow-scripts' : '';
}

/** The content policy put at the top of the page: nothing is fetched from anywhere. */
export function sandboxPolicy({ allowScripts = false, cdn = false }: SandboxOptions = {}): string {
  const hosts = cdn ? ` ${CDN_HOSTS.join(' ')}` : '';
  const parts = [
    "default-src 'none'",
    'img-src data: blob:',
    'media-src data: blob:',
    `font-src data:${hosts}`,
    `style-src 'unsafe-inline'${hosts}`,
    "form-action 'none'",
    "base-uri 'none'",
  ];
  // No `connect-src`: the page cannot fetch, post or open a socket anywhere, with or without the CDN list.
  if (allowScripts) parts.push(`script-src 'unsafe-inline'${hosts}`);
  return parts.join('; ');
}

/** The page with the policy as its first element (after a doctype, so the page keeps its standards mode). */
export function sandboxDocument(html: string, options: SandboxOptions = {}): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${sandboxPolicy(options)}">`;
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) return doctype[0] + meta + html.slice(doctype[0].length);
  return meta + html;
}

export function SandboxFrame({
  html,
  src,
  title,
  allowScripts = false,
  cdn = false,
  className = 'ck-sandbox',
}: {
  /** The page as text (shown with the policy added). */
  html?: string;
  /** Or a `blob:` / `data:` address, for a file the system's own viewer shows (a PDF). Gets the same sandbox. */
  src?: string;
  title: string;
  allowScripts?: boolean;
  /** Allow the short CDN list (`CDN_HOSTS`) for scripts, styles and fonts. */
  cdn?: boolean;
  className?: string;
}) {
  const doc = useMemo(() => (html === undefined ? undefined : sandboxDocument(html, { allowScripts, cdn })), [html, allowScripts, cdn]);
  return (
    <iframe
      className={className}
      title={title}
      data-testid="sandbox-frame"
      sandbox={sandboxAttribute({ allowScripts })}
      referrerPolicy="no-referrer"
      srcDoc={doc}
      src={doc === undefined ? src : undefined}
    />
  );
}
