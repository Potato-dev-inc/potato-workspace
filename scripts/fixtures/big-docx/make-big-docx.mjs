#!/usr/bin/env node
// Writes a big Word file for testing the viewer: text, a table, and MANY real pictures (noise PNGs, so they do not
// compress: the file is as big as asked). Nothing is committed; the file goes where you say (default: the temp folder).
// Usage: node scripts/fixtures/big-docx/make-big-docx.mjs [--mb 60] [--out <file>] [--pictures 40]
// Example data only.
import { createWriteStream, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomFillSync } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { pipeline } from 'node:stream/promises';

const require = createRequire(import.meta.url);
const JSZip = require('jszip');
const args = process.argv.slice(2);
const arg = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const MB = Number(arg('--mb', 60));
const COUNT = Number(arg('--pictures', 40));
const out = path.resolve(arg('--out', path.join(tmpdir(), `big-report-${MB}mb.docx`)));

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type), data]);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, tail]);
};
/** A noise picture of w x h (RGB): incompressible, so its PNG is about w*h*3 bytes. */
function noisePng(w, h) {
  const row = w * 3 + 1;
  const raw = Buffer.alloc(row * h);
  randomFillSync(raw);
  for (let y = 0; y < h; y++) raw[y * row] = 0; // filter type 0
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 0 })), chunk('IEND', Buffer.alloc(0))]);
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const zip = new JSZip();
zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>');
zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`);
const rels = [`<Relationship Id="rIdStyles" Type="${REL}/styles" Target="styles.xml"/>`];
zip.file('word/styles.xml', `<?xml version="1.0" encoding="UTF-8"?><w:styles ${W}><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style></w:styles>`);

// Pictures: sized so COUNT of them make about MB megabytes.
const bytesEach = (MB * 1024 * 1024) / COUNT;
const side = Math.round(Math.sqrt(bytesEach / 3 / 0.75)); // 4:3 picture
const w = side;
const h = Math.round(w * 0.75);
const p = (t, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
const picture = (i) =>
  `<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><wp:extent cx="4320000" cy="3240000"/><wp:docPr id="${i + 1}" name="Photo ${i + 1}" descr="Photo ${i + 1}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip r:embed="rIdImg${i}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
const cell = (t) => `<w:tc><w:p><w:r><w:t>${t}</w:t></w:r></w:p></w:tc>`;
const body = [p('Monthly report', 'Heading1'), p('Activities of the month, with photos.')];
for (let i = 0; i < COUNT; i++) {
  body.push(p(`Activity ${i + 1}`, 'Heading2'));
  for (let k = 0; k < 6; k++) body.push(p(`Paragraph ${k + 1} of activity ${i + 1}. People came, we talked, we drank tea and did the exercises together.`));
  if (i % 10 === 0) body.push(`<w:tbl><w:tr>${cell('Week')}${cell('People')}</w:tr><w:tr>${cell('1')}${cell('21')}</w:tr></w:tbl>`);
  body.push(picture(i));
  zip.file(`word/media/photo${i}.png`, noisePng(w, h), { compression: 'STORE' });
  rels.push(`<Relationship Id="rIdImg${i}" Type="${REL}/image" Target="media/photo${i}.png"/>`);
}
zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`);
zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${body.join('')}</w:body></w:document>`);

mkdirSync(path.dirname(out), { recursive: true });
await pipeline(zip.generateNodeStream({ streamFiles: true, compression: 'STORE' }), createWriteStream(out));
console.log(`${out}  ${COUNT} pictures of ${w}x${h}`);
