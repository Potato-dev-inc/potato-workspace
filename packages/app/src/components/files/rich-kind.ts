// Which files get a viewer of their own beside the chat (the rest are code, Markdown, pictures or "not text").
import { extensionOf } from './languages';

export type RichKind = 'docx' | 'pdf' | 'sheet' | 'html';

const BY_EXTENSION: Record<string, RichKind> = {
  docx: 'docx',
  pdf: 'pdf',
  xlsx: 'sheet',
  xlsm: 'sheet',
  xls: 'sheet',
  csv: 'sheet',
  html: 'html',
  htm: 'html',
};

/** Kinds the system can open in their own program from here (the same list as `files::open_default` on the Rust side). */
const OWN_APP = new Set(['docx', 'doc', 'dotx', 'xlsx', 'xls', 'xlsm', 'csv', 'pptx', 'ppt', 'pdf', 'html', 'htm', 'txt', 'md', 'rtf', 'odt', 'ods']);
export const opensInOwnApp = (path: string): boolean => OWN_APP.has(extensionOf(path));

/** The viewer a path gets, or null for the ordinary text / picture path. */
export function richKindOf(path: string): RichKind | null {
  return BY_EXTENSION[extensionOf(path)] ?? null;
}
