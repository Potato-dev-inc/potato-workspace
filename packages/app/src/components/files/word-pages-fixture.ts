// A long Word file with NO page breaks, the way a report comes out of Word: it only has pages because the text is long.
// It has a header and a footer with "Page X of Y", a table whose first row is marked as a header row, two footnotes,
// an endnote, a text box and a picture that floats on the right. Example data only. Built at test time; used by
// word-pages.test.tsx and the screenshot scenarios.
import JSZip from 'jszip';

const W =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const run = (text: string, props = '') => `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`;
const para = (inner: string, props = '') => `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ''}${inner}</w:p>`;
const field = (instr: string, shown: string) =>
  `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> ${instr} </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${run(shown)}<w:r><w:fldChar w:fldCharType="end"/></w:r>`;
const cell = (width: number, inner: string) => `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/></w:tcPr>${inner}</w:tc>`;

const SENTENCE = 'The group met at the community hall, shared a meal, did light exercise and talked about the week. ';

export interface PagesOptions {
  /** Body paragraphs of about 500 letters each (no page breaks anywhere). */
  paragraphs?: number;
  /** Rows of the table (its first row repeats as a header). 0 leaves the table out. */
  tableRows?: number;
  footnotes?: boolean;
  textBox?: boolean;
  floatingPicture?: boolean;
  letter?: boolean;
}

export async function longReportBase64(o: PagesOptions = {}): Promise<string> {
  const { paragraphs = 40, tableRows = 30, footnotes = true, textBox = true, floatingPicture = true, letter = false } = o;
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file(
    'word/_rels/document.xml.rels',
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdSt" Type="${REL}/styles" Target="styles.xml"/><Relationship Id="rIdH" Type="${REL}/header" Target="header1.xml"/><Relationship Id="rIdF" Type="${REL}/footer" Target="footer1.xml"/><Relationship Id="rIdFn" Type="${REL}/footnotes" Target="footnotes.xml"/><Relationship Id="rIdEn" Type="${REL}/endnotes" Target="endnotes.xml"/><Relationship Id="rIdImg" Type="${REL}/image" Target="media/photo.png"/></Relationships>`,
  );
  zip.file(
    'word/styles.xml',
    `<?xml version="1.0" encoding="UTF-8"?><w:styles ${W}>` +
      '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="PMingLiU"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
      '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
      '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/></w:pPr><w:rPr><w:b/><w:color w:val="1F3864"/><w:sz w:val="32"/></w:rPr></w:style>' +
      '<w:style w:type="paragraph" w:styleId="FootnoteText"><w:name w:val="footnote text"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="20"/></w:rPr></w:style>' +
      '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/></w:style>' +
      '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:color="auto"/><w:left w:val="single" w:sz="4" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:color="auto"/><w:right w:val="single" w:sz="4" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:color="auto"/></w:tblBorders></w:tblPr></w:style>' +
      '</w:styles>',
  );
  zip.file('word/header1.xml', `<?xml version="1.0" encoding="UTF-8"?><w:hdr ${W}>${para(run('Care Station Annual Review', '<w:color w:val="595959"/><w:sz w:val="18"/>'), '<w:jc w:val="center"/>')}</w:hdr>`);
  zip.file('word/footer1.xml', `<?xml version="1.0" encoding="UTF-8"?><w:ftr ${W}>${para(`${run('Page ')}${field('PAGE', '1')}${run(' of ')}${field('NUMPAGES', '1')}`, '<w:jc w:val="right"/>')}</w:ftr>`);
  zip.file(
    'word/footnotes.xml',
    `<?xml version="1.0" encoding="UTF-8"?><w:footnotes ${W}><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:id="1">${para(`<w:r><w:footnoteRef/></w:r>${run(' Figures come from the sign-in sheet.')}`, '<w:pStyle w:val="FootnoteText"/>')}</w:footnote><w:footnote w:id="2">${para(`<w:r><w:footnoteRef/></w:r>${run(' Cooking days are counted once per month.')}`, '<w:pStyle w:val="FootnoteText"/>')}</w:footnote></w:footnotes>`,
  );
  zip.file('word/endnotes.xml', `<?xml version="1.0" encoding="UTF-8"?><w:endnotes ${W}><w:endnote w:id="1">${para(`<w:r><w:endnoteRef/></w:r>${run(' Thanks to the volunteers who made this year possible.')}`)}</w:endnote></w:endnotes>`);
  zip.file('word/media/photo.png', PNG, { base64: true });

  const ref = (kind: 'footnote' | 'endnote', id: number) => `<w:r><w:${kind}Reference w:id="${id}"/></w:r>`;
  const body: string[] = [para(run('Annual review'), '<w:pStyle w:val="Heading1"/>')];
  if (floatingPicture) {
    body.push(
      `<w:p><w:r><w:drawing><wp:anchor distT="0" distB="0" distL="114300" distR="114300" behindDoc="0"><wp:positionH relativeFrom="margin"><wp:align>right</wp:align></wp:positionH><wp:extent cx="1905000" cy="1143000"/><wp:wrapSquare wrapText="bothSides"/><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="rIdImg"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>${run(`${SENTENCE.repeat(5)}`)}</w:p>`,
    );
  }
  if (textBox) {
    body.push(
      `<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:anchor distT="0" distB="0" distL="114300" distR="114300" behindDoc="0"><wp:positionH relativeFrom="margin"><wp:align>left</wp:align></wp:positionH><wp:extent cx="2286000" cy="762000"/><wp:wrapSquare wrapText="bothSides"/><a:graphic><a:graphicData><wps:wsp><wps:spPr><a:solidFill><a:srgbClr val="FFF2CC"/></a:solidFill><a:ln w="12700"><a:solidFill><a:srgbClr val="BF9000"/></a:solidFill></a:ln></wps:spPr><wps:txbx><w:txbxContent>${para(run('Key number', '<w:b/>'))}${para(run('1,240 meals shared this year'))}</w:txbxContent></wps:txbx><wps:bodyPr/></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice><mc:Fallback><w:pict/></mc:Fallback></mc:AlternateContent></w:r>${run(SENTENCE.repeat(4))}</w:p>`,
    );
  }
  for (let i = 0; i < paragraphs; i++) {
    let inner = run(`${i + 1}. ${SENTENCE.repeat(5)}`);
    if (footnotes && i === 2) inner += ref('footnote', 1) + run(' ');
    if (footnotes && i === 9) inner += ref('footnote', 2) + run(' ');
    if (footnotes && i === paragraphs - 1) inner += ref('endnote', 1) + run(' ');
    body.push(para(inner));
    if (i === 14 && tableRows > 0) {
      const widths = [1800, 3200, 2400];
      const head = `<w:tr><w:trPr><w:tblHeader/></w:trPr>${['Date', 'Activity', 'People'].map((h, k) => cell(widths[k], para(run(h, '<w:b/>')))).join('')}</w:tr>`;
      const rows = Array.from({ length: tableRows }, (_, r) => `<w:tr>${cell(widths[0], para(run(`11/${r + 1}`)))}${cell(widths[1], para(run(r % 2 ? '長者共餐' : 'Group exercise')))}${cell(widths[2], para(run(String(10 + r))))}</w:tr>`).join('');
      body.push(`<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="7400" w:type="dxa"/></w:tblPr><w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>${head}${rows}</w:tbl>`);
    }
  }
  const size = letter ? '<w:pgSz w:w="12240" w:h="15840"/>' : '<w:pgSz w:w="11906" w:h="16838"/>';
  const sect = `<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/><w:footerReference w:type="default" r:id="rIdF"/>${size}<w:pgMar w:top="1440" w:right="1134" w:bottom="1440" w:left="1134" w:header="720" w:footer="720"/></w:sectPr>`;
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${body.join('')}${sect}</w:body></w:document>`);
  return zip.generateAsync({ type: 'base64', compression: 'DEFLATE' });
}
