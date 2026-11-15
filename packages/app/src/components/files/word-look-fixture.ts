// A monthly report made the way Word makes one: styles with fonts and colours, a header and a footer with a page number,
// a table with borders, shading, merged cells and set widths, a page break, a list, a picture. Example data only.
// Built at test time (nothing binary is committed); used by word-look.test.tsx and the screenshot harness.
import JSZip from 'jszip';

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const run = (text: string, props = '') => `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`;
const para = (inner: string, props = '') => `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ''}${inner}</w:p>`;
const cell = (width: number, inner: string, props = '') =>
  `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${props}</w:tcPr>${inner}</w:tc>`;

/** `rows` is the number of body rows of the big table (a real monthly report has dozens). */
export async function styledReportBase64(rows = 6): Promise<string> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file(
    'word/_rels/document.xml.rels',
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdSt" Type="${REL}/styles" Target="styles.xml"/><Relationship Id="rIdH" Type="${REL}/header" Target="header1.xml"/><Relationship Id="rIdF" Type="${REL}/footer" Target="footer1.xml"/><Relationship Id="rIdNum" Type="${REL}/numbering" Target="numbering.xml"/><Relationship Id="rIdImg" Type="${REL}/image" Target="media/photo.png"/></Relationships>`,
  );
  zip.file(
    'word/styles.xml',
    `<?xml version="1.0" encoding="UTF-8"?><w:styles ${W}>` +
      '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="PMingLiU"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
      '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
      '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="240" w:after="80"/></w:pPr><w:rPr><w:b/><w:color w:val="1F3864"/><w:sz w:val="32"/></w:rPr></w:style>' +
      '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/></w:style>' +
      '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:color="auto"/><w:left w:val="single" w:sz="4" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:color="auto"/><w:right w:val="single" w:sz="4" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:color="auto"/></w:tblBorders></w:tblPr></w:style>' +
      '</w:styles>',
  );
  zip.file(
    'word/numbering.xml',
    `<?xml version="1.0" encoding="UTF-8"?><w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`,
  );
  zip.file('word/header1.xml', `<?xml version="1.0" encoding="UTF-8"?><w:hdr ${W}>${para(run('Care Station Monthly Report', '<w:color w:val="595959"/><w:sz w:val="18"/>'), '<w:jc w:val="center"/>')}</w:hdr>`);
  zip.file(
    'word/footer1.xml',
    `<?xml version="1.0" encoding="UTF-8"?><w:ftr ${W}>${para(`${run('Page ')}<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${run('1')}<w:r><w:fldChar w:fldCharType="end"/></w:r>`, '<w:jc w:val="right"/>')}</w:ftr>`,
  );
  zip.file('word/media/photo.png', PNG, { base64: true });

  const widths = [1800, 2600, 2600, 2000];
  const head =
    '<w:tr><w:trPr><w:tblHeader/></w:trPr>' +
    ['Date', 'Activity', 'Place', 'People']
      .map((h, i) => cell(widths[i], para(run(h, '<w:b/>'), '<w:jc w:val="center"/>'), '<w:shd w:val="clear" w:color="auto" w:fill="D9E2F3"/>'))
      .join('') +
    '</w:tr>';
  const body = Array.from({ length: rows }, (_, i) => {
    const merged = i === 1;
    return (
      '<w:tr>' +
      cell(widths[0], para(run(`10/${i + 1}`))) +
      (merged
        ? cell(widths[1] + widths[2], para(run('Health talk (two columns)')), '<w:gridSpan w:val="2"/>')
        : cell(widths[1], para(run(i % 2 ? '長者共餐' : 'Group exercise'))) + cell(widths[2], para(run('Community hall')))) +
      cell(widths[3], para(run(String(12 + i))), '<w:tcBorders><w:bottom w:val="double" w:sz="6" w:color="C00000"/></w:tcBorders>') +
      '</w:tr>'
    );
  }).join('');
  const table = `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="${widths.reduce((a, b) => a + b, 0)}" w:type="dxa"/></w:tblPr><w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>${head}${body}</w:tbl>`;
  const image =
    '<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><wp:extent cx="1905000" cy="952500"/><a:graphic><a:graphicData><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:blipFill><a:blip r:embed="rIdImg"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
  const content = [
    para(run('October activity report'), '<w:pStyle w:val="Heading1"/><w:jc w:val="center"/>'),
    para(run('Station: ', '<w:b/>') + run('Pingding', '<w:i/><w:color w:val="C00000"/>') + run('  坪頂月報表', '<w:rFonts w:eastAsia="PMingLiU"/>'), '<w:jc w:val="right"/>'),
    table,
    para(`${run('Page break below.')}<w:r><w:br w:type="page"/></w:r>`),
    para(run('Notes for next month'), '<w:pStyle w:val="Heading1"/>'),
    para(run('Invite more neighbours'), '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'),
    para(run('Buy new chairs'), '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'),
    image,
  ].join('');
  const sect =
    '<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/><w:footerReference w:type="default" r:id="rIdF"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1134" w:bottom="1440" w:left="1134" w:header="720" w:footer="720"/></w:sectPr>';
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${content}${sect}</w:body></w:document>`);
  return zip.generateAsync({ type: 'base64', compression: 'DEFLATE' });
}
