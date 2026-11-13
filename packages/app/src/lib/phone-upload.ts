// A photo or file from the phone for an agent (P14). The phone checks the same limits the PC checks (10 MB, pictures, PDF and
// common text files), reads the file as base64 and sends it to `POST /panes/{id}/uploads`; the PC saves it in its phone-uploads
// folder and answers the attachment (name, path, kind) that goes with the next message. Pure code with no Tauri import.
import type { BridgeClient } from './bridge-types';
import type { ChatAttachment } from './attachFiles';
import { bridgeRefusalText } from './paneOutbox-bridge';

/** The most a file may weigh (bytes). The PC refuses more. */
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
/** Most files on one message. */
export const UPLOAD_MAX_FILES = 5;

export const IMAGE_TYPES = ['png', 'jpg', 'jpeg', 'gif', 'webp'] as const;
export const TEXT_TYPES = [
  'txt', 'md', 'json', 'csv', 'log', 'yaml', 'yml', 'toml', 'xml', 'html', 'css', 'js', 'ts', 'tsx', 'jsx', 'py', 'rs', 'go', 'java', 'c', 'h', 'cpp', 'sh', 'sql',
] as const;

/** What the "Photos" picker offers. */
export const PHOTO_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp';
/** What the "Files" picker offers (pictures too). */
export const FILE_ACCEPT = [...IMAGE_TYPES, 'pdf', ...TEXT_TYPES].map((ext) => `.${ext}`).join(',');

/** The body of `POST /panes/{id}/uploads`. */
export interface PhoneUploadBody {
  name: string;
  mime: string;
  data_base64: string;
}

/** The answer of `GET /panes/{id}/result` (see `bridge/routes/phone_result.rs`). */
export interface PaneResult {
  available: boolean;
  turn?: number;
  sentence?: string;
  agent?: string;
  endedAtMs?: number;
  durationMs?: number;
  files?: { count: number; added: number; deleted: number; paths: string[] } | null;
  /** The checks line of a run-backed agent ("all checks passed (3/3)"), when the PC knows it. */
  tests?: string | null;
  failed?: boolean;
  changes?: { path: string; status: string; added: number; deleted: number; binary: boolean }[] | null;
  patch?: string;
  patchCut?: boolean;
}

export type UploadCheck = { ok: true } | { ok: false; reason: 'type' | 'big' | 'empty' };

/** The lower-case extension of a file name, or ''. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** Whether the type is one the PC takes. A camera photo may arrive with no usable name, so the mime type counts too. */
export function allowedType(name: string, mime: string): boolean {
  const ext = extensionOf(name);
  if ((IMAGE_TYPES as readonly string[]).includes(ext) || ext === 'pdf' || (TEXT_TYPES as readonly string[]).includes(ext)) return true;
  return ext === '' && /^image\/(png|jpeg|gif|webp)$/.test(mime);
}

export function checkUpload(file: { name: string; size: number; type: string }): UploadCheck {
  if (file.size <= 0) return { ok: false, reason: 'empty' };
  if (file.size > UPLOAD_MAX_BYTES) return { ok: false, reason: 'big' };
  if (!allowedType(file.name, file.type)) return { ok: false, reason: 'type' };
  return { ok: true };
}

/** A name the PC will take: a photo with no extension gets one from its mime type. */
export function uploadName(file: { name: string; type: string }): string {
  const base = file.name.trim() || 'photo';
  if (extensionOf(base) !== '') return base;
  const sub = file.type.split('/')[1] ?? '';
  return `${base}.${sub === 'jpeg' ? 'jpg' : sub || 'png'}`;
}

/** Reads a file as base64 (no data-URL prefix). */
export function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : '');
    };
    reader.readAsDataURL(file);
  });
}

/** Sends one file to the PC for this pane. Rejects with the PC's plain sentence when it says no. */
export async function uploadFile(bridge: BridgeClient, paneId: string, file: File, failed: string): Promise<ChatAttachment> {
  if (!bridge.uploadPaneFile) throw new Error(failed);
  const data = await fileToBase64(file);
  try {
    return await bridge.uploadPaneFile(paneId, { name: uploadName(file), mime: file.type, data_base64: data });
  } catch (error) {
    throw new Error(bridgeRefusalText(error, failed));
  }
}

/** "1.2 MB", "340 KB". */
export function sizeWords(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
