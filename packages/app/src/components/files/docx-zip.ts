// A Word file is a zip, and a report full of photos is mostly photos. To show the text of a 60 MB (or 400 MB) file
// without reading it all, this reads only the zip's directory and the small parts (the document, styles, links) by
// byte ranges, and builds a "slim" zip for mammoth in which every picture is a tiny stand-in that holds the picture's
// own path. A picture is read from the real file, by its range, only when the page asks for it.
// No screen and no DOM: it runs in the office worker. It needs a server that answers `Range` (the app's `pmfile`
// stream does); `urlReader` says `null` when it does not, and the caller reads the whole file instead.

/** Reads bytes `start..=end` of a file. */
export interface RangeReader {
  size: number;
  read(start: number, end: number): Promise<ArrayBuffer>;
}

export function bytesReader(bytes: Uint8Array): RangeReader {
  return {
    size: bytes.byteLength,
    read: async (start, end) => bytes.slice(start, end + 1).buffer as ArrayBuffer,
  };
}

const TAIL = 65558; // the zip's end record (22 bytes) plus the longest comment (65535), and a little more

/** A reader over a stream address, or `null` when the server does not answer ranges. */
export async function urlReader(url: string): Promise<RangeReader | null> {
  const res = await fetch(url, { headers: { Range: `bytes=-${TAIL}` } });
  if (res.status !== 206) return null;
  const total = /\/(\d+)\s*$/.exec(res.headers.get('Content-Range') ?? '');
  if (!total) return null;
  const size = Number(total[1]);
  const tail = await res.arrayBuffer();
  const tailStart = size - tail.byteLength;
  return {
    size,
    read: async (start, end) => {
      if (start >= tailStart) return tail.slice(start - tailStart, end - tailStart + 1);
      const part = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
      if (part.status !== 206) throw new Error(`range ${part.status}`);
      return part.arrayBuffer();
    },
  };
}

interface Entry {
  name: string;
  method: number;
  crc: number;
  csize: number;
  usize: number;
  offset: number;
}

const u16 = (v: DataView, at: number) => v.getUint16(at, true);
const u32 = (v: DataView, at: number) => v.getUint32(at, true);

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** The entries of the zip, from its end record and central directory. */
async function readDirectory(reader: RangeReader): Promise<Entry[]> {
  const from = Math.max(0, reader.size - TAIL);
  const tail = new Uint8Array(await reader.read(from, reader.size - 1));
  const view = new DataView(tail.buffer);
  let at = tail.length - 22;
  while (at >= 0 && u32(view, at) !== 0x06054b50) at--;
  if (at < 0) throw new Error('not a zip');
  const count = u16(view, at + 10);
  const dirSize = u32(view, at + 12);
  const dirOffset = u32(view, at + 16);
  if (count === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff) throw new Error('zip64');
  const dir = new Uint8Array(await reader.read(dirOffset, dirOffset + dirSize - 1));
  const dv = new DataView(dir.buffer);
  const names = new TextDecoder();
  const entries: Entry[] = [];
  let p = 0;
  while (p + 46 <= dir.length && u32(dv, p) === 0x02014b50) {
    const nameLen = u16(dv, p + 28);
    entries.push({
      name: names.decode(dir.subarray(p + 46, p + 46 + nameLen)),
      method: u16(dv, p + 10),
      crc: u32(dv, p + 16),
      csize: u32(dv, p + 20),
      usize: u32(dv, p + 24),
      offset: u32(dv, p + 42),
    });
    p += 46 + nameLen + u16(dv, p + 30) + u16(dv, p + 32);
  }
  if (entries.length === 0) throw new Error('empty zip');
  return entries;
}

/** The stored (still compressed) bytes of one entry. */
async function rawData(reader: RangeReader, e: Entry): Promise<Uint8Array> {
  const slack = 1024;
  const want = 30 + new TextEncoder().encode(e.name).length + slack + e.csize;
  const buf = new Uint8Array(await reader.read(e.offset, Math.min(reader.size - 1, e.offset + want - 1)));
  const v = new DataView(buf.buffer);
  const start = 30 + u16(v, 26) + u16(v, 28);
  if (start + e.csize <= buf.length) return buf.subarray(start, start + e.csize);
  return new Uint8Array(await reader.read(e.offset + start, e.offset + start + e.csize - 1));
}

async function inflate(raw: Uint8Array): Promise<Uint8Array> {
  const source = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      controller.enqueue(raw as Uint8Array<ArrayBuffer>);
      controller.close();
    },
  });
  const stream = source.pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A zip of `files` (name, method, crc, sizes, stored bytes), as an ArrayBuffer. */
function writeZip(files: Array<{ name: string; method: number; crc: number; usize: number; data: Uint8Array }>): ArrayBuffer {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const local = new Uint8Array(30 + name.length + f.data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, f.method, true);
    lv.setUint32(14, f.crc, true);
    lv.setUint32(18, f.data.length, true);
    lv.setUint32(22, f.usize, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(f.data, 30 + name.length);
    const head = new Uint8Array(46 + name.length);
    const cv = new DataView(head.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, f.method, true);
    cv.setUint32(16, f.crc, true);
    cv.setUint32(20, f.data.length, true);
    cv.setUint32(24, f.usize, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    head.set(name, 46);
    locals.push(local);
    central.push(head);
    offset += local.length;
  }
  const dirSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, dirSize, true);
  ev.setUint32(16, offset, true);
  const all = new Uint8Array(offset + dirSize + 22);
  let at = 0;
  for (const part of [...locals, ...central, end]) {
    all.set(part, at);
    at += part.length;
  }
  return all.buffer;
}

export interface SlimDocx {
  /** A zip for mammoth: the small parts as they are, each picture a stand-in holding its own path. */
  slim: ArrayBuffer;
  /** The picture at `path` (from the real file), ready to use. */
  readMedia(path: string): Promise<ArrayBuffer>;
}

/** Pictures live here; everything else in a Word file is small. */
const isMedia = (name: string) => name.startsWith('word/media/') || name.startsWith('word/embeddings/');

export async function openSlim(reader: RangeReader): Promise<SlimDocx> {
  const entries = await readDirectory(reader);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const enc = new TextEncoder();
  const files: Array<{ name: string; method: number; crc: number; usize: number; data: Uint8Array }> = [];
  // The small parts, a few at a time.
  const small = entries.filter((e) => !isMedia(e.name) && !e.name.endsWith('/'));
  const data = new Map<string, Uint8Array>();
  for (let i = 0; i < small.length; i += 6) {
    await Promise.all(small.slice(i, i + 6).map(async (e) => data.set(e.name, await rawData(reader, e))));
  }
  for (const e of entries) {
    if (e.name.endsWith('/')) continue;
    if (isMedia(e.name)) {
      const stand = enc.encode(e.name);
      files.push({ name: e.name, method: 0, crc: crc32(stand), usize: stand.length, data: stand });
    } else {
      files.push({ name: e.name, method: e.method, crc: e.crc, usize: e.usize, data: data.get(e.name)! });
    }
  }
  return {
    slim: writeZip(files),
    readMedia: async (path) => {
      const e = byName.get(path);
      if (!e) throw new Error('no such picture');
      const raw = await rawData(reader, e);
      if (e.method === 0) return raw.slice().buffer as ArrayBuffer;
      if (e.method === 8) return (await inflate(raw)).buffer as ArrayBuffer;
      throw new Error(`method ${e.method}`);
    },
  };
}
