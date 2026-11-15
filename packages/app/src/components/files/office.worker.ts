// The worker for big Word and Excel files: it fetches the file from its stream address itself (so the bytes never
// cross threads), converts it, and answers with text first and pictures on request. Messages are in `office-client.ts`.
import { convertFrom, fetchBuffer, pictureBlob, rawText, type Converted } from './docx-engine';
import { urlReader } from './docx-zip';
import { readSheets } from './sheet-read';

type In =
  | { id: number; type: 'docx'; url: string }
  | { id: number; type: 'sheet'; url: string; csv: boolean }
  | { id: number; type: 'text' }
  | { id: number; type: 'image'; index: number };

let doc: Converted | null = null;
const scope = self as unknown as { onmessage: ((e: MessageEvent<In>) => void) | null; postMessage: (m: unknown) => void };

scope.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'docx') {
      const t0 = performance.now();
      doc = await convertFrom(await urlReader(msg.url).catch(() => null), () => fetchBuffer(msg.url));
      scope.postMessage({ id: msg.id, ok: true, html: doc.html, styled: doc.styled, pictures: doc.readers.length, openMs: Math.round(performance.now() - t0) });
    } else if (msg.type === 'text') {
      scope.postMessage({ id: msg.id, ok: true, text: doc ? await rawText(doc.buffer) : '' });
    } else if (msg.type === 'image') {
      const reader = doc?.readers[msg.index];
      scope.postMessage({ id: msg.id, ok: true, blob: reader ? await pictureBlob(reader) : null });
    } else if (msg.type === 'sheet') {
      const bytes = new Uint8Array(await fetchBuffer(msg.url));
      scope.postMessage({ id: msg.id, ok: true, sheets: readSheets(bytes, msg.csv) });
    }
  } catch {
    scope.postMessage({ id: msg.id, ok: false, error: 'failed' });
  }
};
