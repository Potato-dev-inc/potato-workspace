// Files the person adds to a message: the desktop file dialog (several at once) and the text form their paths take.
// Nothing is uploaded and nothing is copied: the message carries paths, which the agent can read on this PC.
import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';

/** True in the desktop app, where a message can carry paths on this PC. */
export const inDesktop = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** A path as it is put in the message: quoted when it has a space. */
export function pathForMessage(path: string): string {
  return /\s/.test(path) ? `"${path}"` : path;
}

/** `text` with `paths` added, one per line after what is already written. */
export function withPaths(text: string, paths: readonly string[]): string {
  if (paths.length === 0) return text;
  const lines = paths.map(pathForMessage).join('\n');
  if (!text.trim()) return `${lines}\n`;
  return `${text.replace(/\s+$/, '')}\n${lines}\n`;
}

/** The system file dialog: several files at once, no folders. Empty when cancelled or outside the desktop app. */
export async function pickFiles(title = 'Add files to your message'): Promise<string[]> {
  if (!inDesktop()) return [];
  const picked = await open({ multiple: true, directory: false, title });
  if (Array.isArray(picked)) return picked.filter((p): p is string => typeof p === 'string');
  return typeof picked === 'string' ? [picked] : [];
}

/** One file ready for a message: text files carry their contents, other files a path the agent can open. */
export interface PreparedAttachment {
  name: string;
  path: string;
  kind: 'text' | 'file';
  text?: string;
  size: number;
  truncated: boolean;
}

/** Reads the picked files on the PC: text goes inline, anything else is copied into the pane's project. */
export async function prepareAttachments(paneId: string, paths: readonly string[]): Promise<PreparedAttachment[]> {
  if (!inDesktop() || paths.length === 0) return [];
  return invoke<PreparedAttachment[]>('attachment_prepare', { paneId, paths: [...paths] });
}

/** The block one prepared file adds to the message. */
export function attachmentBlock(file: PreparedAttachment): string {
  if (file.kind === 'text' && file.text !== undefined) {
    const cut = file.truncated ? `\n… (the rest is in ${file.path})` : '';
    return `Attached file: ${file.name}\n\`\`\`\n${file.text}\n\`\`\`${cut}`;
  }
  return `Attached file: ${file.name} (${file.path}). Open it with your file tools before answering.`;
}

/** `text` with every prepared file added after what is already written. */
export function withAttachments(text: string, files: readonly PreparedAttachment[]): string {
  if (files.length === 0) return text;
  const blocks = files.map(attachmentBlock).join('\n\n');
  if (!text.trim()) return `${blocks}\n`;
  return `${text.replace(/\s+$/, '')}\n\n${blocks}\n`;
}
