// The page's side of the office worker. A stream address goes to a worker (the page stays responsive while a
// 60 MB Word file is unzipped and converted); bytes already in hand (tests, the dev page) run in the page.
import type { FileSource } from '../../lib/files-api';
import { convertFrom, fetchBuffer, pictureBlob, rawText, type Converted } from './docx-engine';
import { bytesReader } from './docx-zip';
import { readSheets, type Sheet } from './sheet-read';

export interface DocxSession {
  /** The page as HTML (pictures are placeholders) and how many pictures there are. */
  opened: Promise<{ html: string; pictures: number; openMs?: number }>;
  /** The plain text of the document. */
  text(): Promise<string>;
  /** Picture number `index`, shown-size; `null` when the web view cannot draw it. */
  picture(index: number): Promise<Blob | null>;
  close(): void;
}

type Reply = { id: number; ok: boolean; error?: string; [key: string]: unknown };

/** A worker, with calls that answer when the worker replies. */
function startWorker() {
  const worker = new Worker(new URL('./office.worker.ts', import.meta.url), { type: 'module' });
  let next = 1;
  const waiting = new Map<number, { resolve: (r: Reply) => void; reject: (e: Error) => void }>();
  worker.onmessage = (e: MessageEvent<Reply>) => {
    const slot = waiting.get(e.data.id);
    if (!slot) return;
    waiting.delete(e.data.id);
    if (e.data.ok) slot.resolve(e.data);
    else slot.reject(new Error(e.data.error ?? 'worker failed'));
  };
  worker.onerror = () => {
    for (const slot of waiting.values()) slot.reject(new Error('worker failed'));
    waiting.clear();
  };
  return {
    call: (msg: Record<string, unknown>) =>
      new Promise<Reply>((resolve, reject) => {
        const id = next++;
        waiting.set(id, { resolve, reject });
        worker.postMessage({ ...msg, id });
      }),
    stop: () => {
      worker.terminate();
      for (const slot of waiting.values()) slot.reject(new Error('closed'));
      waiting.clear();
    },
  };
}

const canUseWorker = (source: FileSource): source is { url: string } => 'url' in source && typeof Worker !== 'undefined';

async function bufferOf(source: FileSource): Promise<ArrayBuffer> {
  if ('bytes' in source) {
    const b = source.bytes;
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  }
  return fetchBuffer(source.url);
}

export function openDocx(source: FileSource): DocxSession {
  if (canUseWorker(source)) {
    const w = startWorker();
    const opened = w.call({ type: 'docx', url: source.url }).then((r) => ({ html: r.html as string, pictures: r.pictures as number, openMs: r.openMs as number }));
    opened.catch(() => undefined);
    return {
      opened,
      text: () => w.call({ type: 'text' }).then((r) => r.text as string),
      picture: (index) => w.call({ type: 'image', index }).then((r) => (r.blob as Blob | null) ?? null),
      close: w.stop,
    };
  }
  let done: Converted | null = null;
  const opened = convertFrom('bytes' in source ? bytesReader(source.bytes) : null, () => bufferOf(source))
    .then((c) => {
      done = c;
      return { html: c.html, pictures: c.readers.length };
    });
  opened.catch(() => undefined);
  return {
    opened,
    text: async () => (done ? rawText(done.buffer) : ''),
    picture: async (index) => (done?.readers[index] ? pictureBlob(done.readers[index]) : null),
    close: () => {
      done = null;
    },
  };
}

/** The sheets of a spreadsheet file; `stop` ends the worker (a person closed the tab). */
export function openSheets(source: FileSource, csv: boolean): { sheets: Promise<Sheet[]>; stop: () => void } {
  if (canUseWorker(source)) {
    const w = startWorker();
    const sheets = w.call({ type: 'sheet', url: source.url, csv }).then((r) => {
      w.stop();
      return r.sheets as Sheet[];
    });
    sheets.catch(() => undefined);
    return { sheets, stop: w.stop };
  }
  return { sheets: bufferOf(source).then((b) => readSheets(new Uint8Array(b), csv)), stop: () => undefined };
}
