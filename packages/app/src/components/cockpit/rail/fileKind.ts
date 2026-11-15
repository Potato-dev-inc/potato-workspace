// What kind of file a name is: its colour on the right panel (a file-type token) and the word the Outputs row shows.
export type FileTone = 'code' | 'style' | 'data' | 'doc' | 'image' | 'web' | 'plain';
export type OutputKind = 'page' | 'note' | 'picture' | 'data' | 'word' | 'sheet' | 'pdf' | 'file';

const TONES: Record<string, FileTone> = {
  ts: 'code', tsx: 'code', js: 'code', jsx: 'code', mjs: 'code', cjs: 'code', rs: 'code', py: 'code', go: 'code', java: 'code', kt: 'code', swift: 'code', c: 'code', h: 'code', cpp: 'code', cs: 'code', rb: 'code', php: 'code', sh: 'code', ps1: 'code', sql: 'code',
  css: 'style', scss: 'style', sass: 'style', less: 'style',
  json: 'data', yaml: 'data', yml: 'data', toml: 'data', csv: 'data', tsv: 'data', lock: 'data', xlsx: 'data', xls: 'data',
  md: 'doc', txt: 'doc', docx: 'doc', doc: 'doc', pdf: 'doc', rtf: 'doc',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', ico: 'image', bmp: 'image',
  html: 'web', htm: 'web',
};

export function extOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

export function fileTone(name: string): FileTone {
  return TONES[extOf(name)] ?? 'plain';
}

const KINDS: Record<string, OutputKind> = {
  html: 'page', htm: 'page',
  md: 'note', txt: 'note',
  png: 'picture', jpg: 'picture', jpeg: 'picture', gif: 'picture', webp: 'picture', svg: 'picture',
  json: 'data', csv: 'data', tsv: 'data', yaml: 'data', yml: 'data',
  docx: 'word', doc: 'word',
  xlsx: 'sheet', xls: 'sheet',
  pdf: 'pdf',
};

/** The Outputs kind of a file, or null for source code, styles and the like (those are changes, not outputs). */
export function outputKind(name: string): OutputKind | null {
  return KINDS[extOf(name)] ?? null;
}
