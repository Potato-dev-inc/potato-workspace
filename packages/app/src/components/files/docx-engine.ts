// Word files, the heavy part. This module has no screen and no DOM, so it runs in the worker (`office.worker.ts`) and,
// when there is no worker (tests), in the page. mammoth turns the document into HTML; pictures are NOT read here:
// each one becomes a small placeholder `<img id="pmimg-N">` and its bytes are read from the zip only when the screen
// asks for number N (when it scrolls near). A 60 MB report full of photos shows its text at once.
import mammoth from 'mammoth/mammoth.browser';
import { openSlim, type RangeReader } from './docx-zip';

/** A 1x1 transparent picture: what a photo shows before it is loaded. */
export const PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
export const IMAGE_ID_PREFIX = 'pmimg-';
/** Pictures wider than this are drawn smaller for the page (a photo of 4000 px does not need to be decoded whole on screen). */
export const PREVIEW_WIDTH = 1000;
/** Pictures under this size are shown as they are. */
const SMALL_PICTURE = 300 * 1024;

type Reader = () => Promise<{ type: string; buffer: ArrayBuffer }>;

export interface Converted {
  html: string;
  /** The readers of the pictures, by number. */
  readers: Reader[];
  buffer: ArrayBuffer;
}

/** Fetches a stream address into memory (the worker does this itself, so a 60 MB file never crosses threads). */
export async function fetchBuffer(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`stream ${res.status}`);
  return res.arrayBuffer();
}

/**
 * `media` is set when `buffer` is a slim zip (see `docx-zip.ts`): a picture's bytes in it are only its path, and the
 * real picture is read from the file by `media`.
 */
export async function convertDocx(buffer: ArrayBuffer, media?: (path: string) => Promise<ArrayBuffer>): Promise<Converted> {
  const readers: Reader[] = [];
  const convertImage = mammoth.images.imgElement((image) => {
    const i = readers.length;
    readers.push(async () => {
      const own = await image.readAsArrayBuffer();
      return { type: image.contentType, buffer: media ? await media(new TextDecoder().decode(own)) : own };
    });
    return Promise.resolve({ src: PLACEHOLDER, id: `${IMAGE_ID_PREFIX}${i}` } as { src: string });
  });
  const out = await mammoth.convertToHtml({ arrayBuffer: buffer }, { convertImage });
  return { html: out.value, readers, buffer };
}

/**
 * A document from a reader that answers byte ranges (only the small parts are read, pictures stay in the file), or,
 * when there is none or the file is not an ordinary Word zip, from the whole file.
 */
export async function convertFrom(reader: RangeReader | null, whole: () => Promise<ArrayBuffer>): Promise<Converted> {
  if (reader) {
    try {
      const slim = await openSlim(reader);
      return await convertDocx(slim.slim, slim.readMedia);
    } catch {
      /* not readable by ranges: read the whole file below */
    }
  }
  return convertDocx(await whole());
}

export async function rawText(buffer: ArrayBuffer): Promise<string> {
  return (await mammoth.extractRawText({ arrayBuffer: buffer })).value;
}

/**
 * One picture of the document, ready to show: small ones as they are; big ones drawn at `PREVIEW_WIDTH` as a JPEG
 * when the page can do that. `null` when it cannot be shown (a format the web view cannot draw, like EMF).
 */
export async function pictureBlob(read: Reader, maxWidth = PREVIEW_WIDTH): Promise<Blob | null> {
  const { type, buffer } = await read();
  if (!/^image\/(png|jpe?g|gif|bmp|webp)$/i.test(type)) return null;
  const original = new Blob([buffer], { type });
  if (buffer.byteLength < SMALL_PICTURE || typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') return original;
  try {
    const bitmap = await createImageBitmap(original);
    if (bitmap.width <= maxWidth) {
      bitmap.close();
      return original;
    }
    const height = Math.max(1, Math.round((bitmap.height * maxWidth) / bitmap.width));
    const canvas = new OffscreenCanvas(maxWidth, height);
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, maxWidth, height);
    bitmap.close();
    return await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
  } catch {
    return original;
  }
}
