#!/usr/bin/env node
// Writes the tiny Word / Excel / CSV / PDF samples the file viewers are tested with (and the screenshot harness uses)
// to packages/app/src/components/files/office-fixtures.ts as base64. Example data only.
// Usage: node scripts/fixtures/office/make-office-fixtures.mjs
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const JSZip = require('jszip');
const XLSX = require('xlsx');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const out = path.join(root, 'packages/app/src/components/files/office-fixtures.ts');

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function docx() {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>',
  );
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file(
    'word/_rels/document.xml.rels',
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="${REL}/styles" Target="styles.xml"/><Relationship Id="rIdNum" Type="${REL}/numbering" Target="numbering.xml"/><Relationship Id="rIdImg" Type="${REL}/image" Target="media/pixel.png"/><Relationship Id="rIdBad" Type="${REL}/hyperlink" Target="javascript:alert(1)" TargetMode="External"/><Relationship Id="rIdOk" Type="${REL}/hyperlink" Target="https://example.com/plan" TargetMode="External"/></Relationships>`,
  );
  zip.file('word/styles.xml', `<?xml version="1.0" encoding="UTF-8"?><w:styles ${W}><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style></w:styles>`);
  zip.file('word/numbering.xml', `<?xml version="1.0" encoding="UTF-8"?><w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="-"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`);
  zip.file('word/media/pixel.png', PNG, { base64: true });
  const p = (t, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
  const li = (t) => `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>${t}</w:t></w:r></w:p>`;
  const cell = (t) => `<w:tc><w:p><w:r><w:t>${t}</w:t></w:r></w:p></w:tc>`;
  const row = (...c) => `<w:tr>${c.map(cell).join('')}</w:tr>`;
  const image = '<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><wp:extent cx="100000" cy="100000"/><wp:docPr id="1" name="Picture" descr="A pixel"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip r:embed="rIdImg"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
  const link = (id, t) => `<w:p><w:hyperlink r:id="${id}"><w:r><w:t>${t}</w:t></w:r></w:hyperlink></w:p>`;
  const body = [
    p('Quarterly plan', 'Heading1'),
    p('This plan covers the next three months.'),
    p('Goals', 'Heading2'),
    li('Ship the new sign-in'),
    li('Fix the invoice emails'),
    `<w:tbl>${row('Month', 'Owner')}${row('June', 'Mei')}${row('July', 'Sam')}</w:tbl>`,
    image,
    link('rIdOk', 'Read the full plan'),
    link('rIdBad', 'A link that must be stripped'),
  ].join('');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${body}</w:body></w:document>`);
  return zip.generateAsync({ type: 'base64', compression: 'DEFLATE' });
}

function xlsx() {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Item', 'Price'], ['Tea', 3.5], ['Cake', 6]]), 'Menu');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Day', 'Visitors'], ['Mon', 12], ['Tue', 20]]), 'Visits');
  return XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
}

function pdf() {
  const stream = 'BT /F1 24 Tf 72 700 Td (Hello from a PDF) Tj ET';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let text = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(text.length);
    text += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = text.length;
  text += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(text, 'latin1').toString('base64');
}

const csv = 'Name,City,Score\nMei,Taipei,9\n"Sam, Jr.",Tainan,7\n';
const files = {
  DOCX_SAMPLE: await docx(),
  XLSX_TWO_SHEETS: xlsx(),
  CSV_SAMPLE: Buffer.from(csv).toString('base64'),
  PDF_SAMPLE: pdf(),
};
const lines = ['// Generated by scripts/fixtures/office/make-office-fixtures.mjs. Small example files as base64 (example data only).', ''];
for (const [k, v] of Object.entries(files)) lines.push(`export const ${k} = '${v}';`);
writeFileSync(out, lines.join('\n') + '\n');
console.log('wrote', out, Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v.length])));
