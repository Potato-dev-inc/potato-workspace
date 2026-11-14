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

/** The viewer a path gets, or null for the ordinary text / picture path. */
export function richKindOf(path: string): RichKind | null {
  return BY_EXTENSION[extensionOf(path)] ?? null;
}
