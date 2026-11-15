// A page shown in a locked-down frame: no access to the app, its storage or its commands. It is the one place the
// app shows HTML it did not write (an .html file, later an Artifact). The frame has an opaque origin (never
// `allow-same-origin`), cannot navigate the app, open windows, submit forms or reach the network (the policy inside
// the page allows only pictures and styles that are written into it).
import { useEffect, useMemo, useRef, useState } from 'react';
import { cleanPick, PICK_ARM, PICK_DONE, PICK_SCRIPT, type ArtifactPick } from '../../lib/artifact-point';

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

/** Put in a page on the phone: it tells the app how wide the page wants to be (a number, nothing else). */
export const FIT_MESSAGE = 'potato-fit-width';
const FIT_SCRIPT = `<script>(function(){function r(){try{parent.postMessage({t:'${FIT_MESSAGE}',w:Math.ceil(Math.max(document.documentElement.scrollWidth,document.body?document.body.scrollWidth:0))},'*')}catch(e){}}addEventListener('load',function(){r();setTimeout(r,400)});})()</script>`;

/** The smallest a wide page is shrunk to; a wider page scrolls sideways after that. */
export const MIN_FIT_SCALE = 0.35;

export function SandboxFrame({
  html,
  src,
  title,
  allowScripts = false,
  cdn = false,
  className = 'ck-sandbox',
  fit = false,
  pickable = false,
  picking = false,
  onPick,
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
  /** Phone: fill the width, and shrink a page that wants to be wider than the screen so nothing is cut off or left blank. */
  fit?: boolean;
  /** Put the Point and Fix picker into the page (needs scripts). It only talks by `postMessage`; the page still gets no app access. */
  pickable?: boolean;
  /** The picker is on: the next click in the page is a pick (and does nothing else). */
  picking?: boolean;
  onPick?: (pick: ArtifactPick) => void;
}) {
  const fitting = fit && allowScripts && html !== undefined;
  const withPicker = pickable && allowScripts && html !== undefined;
  const doc = useMemo(
    () => (html === undefined ? undefined : sandboxDocument((fitting ? html + FIT_SCRIPT : html) + (withPicker ? PICK_SCRIPT : ''), { allowScripts, cdn })),
    [html, allowScripts, cdn, fitting, withPicker],
  );
  const frame = useRef<HTMLIFrameElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [wanted, setWanted] = useState(0);
  const armed = useRef(false);
  // Turn the picker on and off. The page hears nothing else from the app, and it never gets an answer back.
  const arm = (on: boolean) => {
    armed.current = on;
    try {
      frame.current?.contentWindow?.postMessage({ t: PICK_ARM, on }, '*');
    } catch {
      // The page is not there (yet).
    }
  };
  useEffect(() => {
    if (withPicker) arm(picking);
  }, [withPicker, picking]);
  useEffect(() => {
    if (!withPicker) return;
    const onMessage = (event: MessageEvent) => {
      const d = event.data as { t?: unknown; pick?: unknown } | null;
      // Only this frame, only a pick, and only while the person asked for one.
      if (event.source !== frame.current?.contentWindow || d?.t !== PICK_DONE || !armed.current) return;
      const pick = cleanPick(d.pick);
      if (pick) onPick?.(pick);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [withPicker, onPick]);
  const [room, setRoom] = useState({ w: 0, h: 0 });
  useEffect(() => {
    if (!fitting) return;
    const onMessage = (event: MessageEvent) => {
      const d = event.data as { t?: unknown; w?: unknown } | null;
      if (event.source !== frame.current?.contentWindow || d?.t !== FIT_MESSAGE || typeof d.w !== 'number' || !Number.isFinite(d.w)) return;
      setWanted(Math.min(Math.max(0, d.w), 20000));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [fitting]);
  useEffect(() => {
    const el = box.current;
    if (!fitting || !el) return;
    const read = () => setRoom({ w: el.clientWidth, h: el.clientHeight });
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver(read);
    watch.observe(el);
    return () => watch.disconnect();
  }, [fitting]);
  const scale = fitting && room.w > 0 && wanted > room.w + 1 ? Math.max(MIN_FIT_SCALE, room.w / wanted) : 1;
  const frameEl = (
    <iframe
      ref={frame}
      className={className}
      title={title}
      data-testid="sandbox-frame"
      sandbox={sandboxAttribute({ allowScripts })}
      referrerPolicy="no-referrer"
      onLoad={withPicker ? () => arm(picking) : undefined}
      srcDoc={doc}
      src={doc === undefined ? src : undefined}
      style={scale < 1 ? { width: room.w / scale, height: room.h / scale, transform: `scale(${scale})`, transformOrigin: '0 0' } : fitting ? { width: '100%' } : undefined}
    />
  );
  if (!fitting) return frameEl;
  return (
    <div ref={box} className="ck-sandbox-fit" data-testid="sandbox-fit" data-scale={scale.toFixed(3)}>
      {frameEl}
    </div>
  );
}
