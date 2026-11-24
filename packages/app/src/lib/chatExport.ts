// "Save chat as page" and "Save as Markdown": the Rust side (commands/chat_export.rs) makes one self-contained HTML
// page or one Markdown file of a pane's chat; these are the typed command wrappers. Desktop only; nothing is uploaded.
import { invoke } from '@tauri-apps/api/core';

import type { Host } from './host/host';
import { idOfKey } from './host/placeKey';

const isTauri = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new Error(`Desktop shell required: ${command}`);
  return invoke<T>(command, args);
}

/** What the export menu needs from the shell (the menu's `ChatExportApi` has the same three). */
interface ChatExportApi {
  html: (paneId: string) => Promise<ExportPage>;
  markdown: (paneId: string) => Promise<ExportMarkdown>;
  save: (token: string, path: string) => Promise<string>;
}

/** What a saved chat can be: one HTML page, or one Markdown file. */
export type ExportFormat = 'page' | 'markdown';

/** The page Rust made (the preview shows `html`) and the one-time token that saves exactly that page. */
export interface ExportPage {
  html: string;
  token: string;
}

/** The Markdown file Rust made (the preview shows `markdown` as text) and the one-time token that saves exactly that file. */
export interface ExportMarkdown {
  markdown: string;
  token: string;
}

/** The whole chat of a pane as one HTML document, with the token that `chatExportSave` needs. */
export function chatExportHtml(paneId: string, title?: string): Promise<ExportPage> {
  return call<ExportPage>('chat_export_html', { paneId, title: title ?? null });
}

/** The whole chat of a pane as one Markdown file, with the token that `chatExportSave` needs. */
export function chatExportMarkdown(paneId: string, title?: string): Promise<ExportMarkdown> {
  return call<ExportMarkdown>('chat_export_markdown', { paneId, title: title ?? null });
}

/** Writes the page or file behind `token` to `path` (what the save dialog returned). The window never sends the text itself. Resolves to the path written. */
export function chatExportSave(token: string, path: string): Promise<string> {
  return call<string>('chat_export_save', { token, path });
}

/**
 * The three calls of the place `host` shows. A chat of another PC is made THERE (`chat_export_html` / `chat_export_markdown`, at most 5 MB), but
 * kept and saved HERE: the desktop shell fetches it, holds it under a one-time token and this PC's own Save dialog writes it, so the window
 * never sends text of its own and nothing is written on the far disk. This PC's own chat takes the usual path.
 */
export function chatExportFor(host: Host): Pick<ChatExportApi, 'html' | 'markdown' | 'save'> {
  if (host.place.kind !== 'pc') return { html: chatExportHtml, markdown: chatExportMarkdown, save: chatExportSave };
  const { node } = host.place;
  const far = (markdown: boolean, paneId: string) => call<Record<string, string>>('devices_chat_export', { node, pane_id: idOfKey(node, paneId), markdown });
  return {
    html: (paneId) => far(false, paneId).then((r) => ({ html: r.html, token: r.token })),
    markdown: (paneId) => far(true, paneId).then((r) => ({ markdown: r.markdown, token: r.token })),
    save: chatExportSave,
  };
}

/** A default file name for the save dialog, e.g. `chat-2026-10-28-1530.html` or `.md` for Markdown. */
export function chatPageFileName(now: Date = new Date(), format: ExportFormat = 'page'): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const ext = format === 'markdown' ? 'md' : 'html';
  return `chat-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.${ext}`;
}
