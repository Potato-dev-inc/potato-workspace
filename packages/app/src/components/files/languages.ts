// Which syntax colouring a file gets, by its extension. Each language pack is loaded only when a file of that kind
// is opened, so the editor adds almost nothing to the first load. Unknown kinds show as plain text.
import type { Extension } from '@codemirror/state';

type Loader = () => Promise<Extension>;

const LOADERS: Record<string, Loader> = {
  js: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true })),
  jsx: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true })),
  mjs: () => import('@codemirror/lang-javascript').then((m) => m.javascript()),
  cjs: () => import('@codemirror/lang-javascript').then((m) => m.javascript()),
  ts: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ typescript: true })),
  tsx: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ typescript: true, jsx: true })),
  rs: () => import('@codemirror/lang-rust').then((m) => m.rust()),
  json: () => import('@codemirror/lang-json').then((m) => m.json()),
  md: () => import('@codemirror/lang-markdown').then((m) => m.markdown()),
  markdown: () => import('@codemirror/lang-markdown').then((m) => m.markdown()),
  css: () => import('@codemirror/lang-css').then((m) => m.css()),
  html: () => import('@codemirror/lang-html').then((m) => m.html()),
  htm: () => import('@codemirror/lang-html').then((m) => m.html()),
  py: () => import('@codemirror/lang-python').then((m) => m.python()),
};

/** The lower-case extension of a path ("src/App.TSX" -> "tsx"), or "". */
export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

export function isMarkdown(path: string): boolean {
  const ext = extensionOf(path);
  return ext === 'md' || ext === 'markdown';
}

/** Whether a path has colouring (without loading it). */
export function hasLanguage(path: string): boolean {
  return extensionOf(path) in LOADERS;
}

/** The language of a path, or null when it has no colouring. */
export function languageFor(path: string): Promise<Extension> | null {
  const load = LOADERS[extensionOf(path)];
  return load ? load() : null;
}
