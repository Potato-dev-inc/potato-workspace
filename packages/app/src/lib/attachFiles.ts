import { rawText } from './sayError';
// Files the person adds to a message: the desktop file dialog (several at once), pasted images, and the typed form
// their paths take. Nothing is uploaded: the backend copies what it must into the pane's project and hands back a
// `ChatAttachment` per file. The message text never carries file contents; the chips show what was attached.
import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import type { Host } from './host/host';
import { localHost } from './host/local';

/** One attached file or folder, as the backend describes it. `path` is what the agent can open on this PC. For a folder, `size` is the number of files in it. */
export type ChatAttachment = {
  name: string;
  path: string;
  kind: 'text' | 'image' | 'file' | 'folder';
  size: number;
  mime?: string;
};

/** The largest pasted image the backend takes (bytes). */
export const MAX_PASTED_IMAGE_BYTES = 20 * 1024 * 1024;

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

/** The picture types the "Add image" dialog lists. */
export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp'];

/** The system file dialog, pictures only. Empty when cancelled or outside the desktop app. */
export async function pickImages(title = 'Add images to your message'): Promise<string[]> {
  if (!inDesktop()) return [];
  const picked = await open({ multiple: true, directory: false, title, filters: [{ name: 'Images', extensions: IMAGE_EXTENSIONS }] });
  if (Array.isArray(picked)) return picked.filter((p): p is string => typeof p === 'string');
  return typeof picked === 'string' ? [picked] : [];
}

/** The system folder dialog: one folder, which goes to the agent by its path. Empty when cancelled or outside the desktop app. */
export async function pickFolder(title = 'Add a folder to your message'): Promise<string[]> {
  if (!inDesktop()) return [];
  const picked = await open({ multiple: false, directory: true, title });
  return typeof picked === 'string' && picked !== '' ? [picked] : [];
}

/** A file of this PC read for another PC (`attachment_read_local`): its bytes travel as base64, and the far PC saves them in its own project. */
interface LocalFile {
  name: string;
  mime: string;
  dataBase64: string;
}

/**
 * Copies the picked files for this pane and describes each one. Empty outside the desktop app. On another PC the files cannot be named by
 * path (a path on this disk means nothing there): each file's bytes are read here and the far PC saves them (one at a time, 20 MB at most each).
 */
export async function prepareAttachments(paneId: string, paths: readonly string[], host: Host = localHost): Promise<ChatAttachment[]> {
  if (!inDesktop() || paths.length === 0) return [];
  if (host.place.kind === 'local') {
    const list = await invoke<ChatAttachment[] | null>('attachment_prepare', { paneId, paths: [...paths] });
    return Array.isArray(list) ? list : [];
  }
  const out: ChatAttachment[] = [];
  try {
    for (const path of paths) {
      const file = await invoke<LocalFile>('attachment_read_local', { path });
      out.push(await host.invoke<ChatAttachment>('attachment_save_pasted', { paneId, name: file.name, mime: file.mime, dataBase64: file.dataBase64 }));
    }
  } catch (error) {
    // The box shows the sentence after the code: ours ("A folder on this PC cannot be sent..."), or the far PC's own.
    const said = rawText(error);
    throw new Error(/^ATTACHMENT_[A-Z_]+:/.test(said) || !said ? said : `ATTACHMENT_FAILED: ${said}`);
  }
  return out;
}

/** The file extension for a pasted image's MIME type (`image/png` gives `png`). */
function extensionFor(mime: string): string {
  const sub = mime.split('/')[1]?.split('+')[0]?.toLowerCase() ?? '';
  if (sub === 'jpeg') return 'jpg';
  return /^[a-z0-9]{1,8}$/.test(sub) ? sub : 'png';
}

/** Reads a blob as base64 (no data-URL prefix). */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : '');
    };
    reader.readAsDataURL(blob);
  });
}

/**
 * Saves an image pasted into the box (image/* only, at most 20 MiB) for this pane. `name` is what the chip shows;
 * without it the file is called `Pasted image.<ext>`.
 */
export async function savePastedImage(paneId: string, blob: Blob, name?: string, host: Host = localHost): Promise<ChatAttachment> {
  if (!blob.type.startsWith('image/')) throw new Error('Only images can be pasted here.');
  if (blob.size > MAX_PASTED_IMAGE_BYTES) throw new Error('That image is larger than 20 MB.');
  const ext = extensionFor(blob.type);
  const dataBase64 = await blobToBase64(blob);
  return host.invoke<ChatAttachment>('attachment_save_pasted', {
    paneId,
    name: name ?? `Pasted image.${ext}`,
    mime: blob.type,
    dataBase64,
  });
}

const PREVIEW_CACHE_MAX = 100;
const previews = new Map<string, Promise<string | null>>();

/**
 * A data URL to show an image attachment, or null (not an image, outside the desktop app, or it cannot be read).
 * Answers are cached in memory per path; a failed read is not kept, so the next call tries again.
 */
export function previewAttachment(path: string, host: Host = localHost, paneId?: string): Promise<string | null> {
  // The key names the place: the same path on two PCs is two files.
  const key = host.place.kind === 'local' ? path : `${host.place.node}|${path}`;
  const cached = previews.get(key);
  if (cached) return cached;
  if (!inDesktop()) return Promise.resolve(null);
  // A far PC without a preview row refuses at the host (nothing is sent, nothing is read here): no thumbnail, the plain placeholder.
  // The far PC reads only inside the chat's own project, so it is told the chat; this PC's command takes the path alone.
  const asked = host.invoke<string | null>('attachment_preview', paneId && host.place.kind !== 'local' ? { paneId, path } : { path }).then(
    (url) => (typeof url === 'string' && url !== '' ? url : null),
    () => {
      previews.delete(key);
      return null;
    },
  );
  previews.set(key, asked);
  if (previews.size > PREVIEW_CACHE_MAX) {
    const oldest = previews.keys().next().value;
    if (oldest !== undefined) previews.delete(oldest);
  }
  return asked;
}
