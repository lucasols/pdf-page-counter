import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, test } from 'vitest';
import { getPdfPageCount } from '../src/main';
import {
  appendUpdate,
  buildPdf,
  createPdfLibPdf,
  flatPageTree,
  objectStream,
  page,
  pageRefs,
  stream,
} from './utils';

const lengthEntryRegex = /\/Length \d+ >>\nstream/;
const whitespaceRegex = /\s/;
const indexEntryRegex = /\/Index \[[^\]]*\]/;
const xrefStmRegex = /\/XRefStm (\d+)/;

function xrefStreamPdf(dictEntries: string, rows: Buffer): Buffer {
  const content = '%PDF-1.7\n';

  return Buffer.concat([
    Buffer.from(`${content}1 0 obj\n`, 'latin1'),
    stream(`/Type /XRef ${dictEntries} /Root 2 0 R`, rows),
    Buffer.from(`\nendobj\nstartxref\n${content.length}\n%%EOF\n`, 'latin1'),
  ]);
}

describe('valid files', () => {
  test('should count the pages of files with an xref table', async () => {
    const pdf = await createPdfLibPdf(7, false);

    expect(getPdfPageCount(pdf)).toMatchInlineSnapshot(`
      {
        "pages": 7,
        "status": "ok",
      }
    `);
  });

  test('should count the pages in object streams listed by an xref stream', async () => {
    const pdf = await createPdfLibPdf(12, true);

    expect(getPdfPageCount(pdf)).toMatchInlineSnapshot(`
      {
        "pages": 12,
        "status": "ok",
      }
    `);
  });

  test('should count the pages in uncompressed object streams', () => {
    // the page tree fills the object stream, whose bytes are skipped in the file and then parsed twice as decoded data
    const pages = 500;
    const objStmNum = 3 + pages;
    const objects: Record<number, string> = {
      1: '<< /Type /Catalog /Pages 2 0 R >>',
      2: `<< /Type /Pages /Kids [${pageRefs(3, pages)}] /Count ${pages} >>`,
    };
    const compressed: Record<number, { objStm: number; index: number }> = {
      1: { objStm: objStmNum, index: 0 },
      2: { objStm: objStmNum, index: 1 },
    };

    for (let i = 0; i < pages; i++) {
      objects[3 + i] = page(2);
      compressed[3 + i] = { objStm: objStmNum, index: 2 + i };
    }

    for (const compressXref of [false, true]) {
      const pdf = buildPdf(
        { [objStmNum]: objectStream(objects, { compress: false }) },
        { xref: 'stream', compressed, compressXref },
      );

      expect(getPdfPageCount(pdf.data)).toEqual({ status: 'ok', pages });
    }
  });

  test('should accept a Uint8Array that is not a Buffer', async () => {
    const pdf = await createPdfLibPdf(3, true);
    const offsetCopy = new Uint8Array(pdf.length + 10);

    offsetCopy.set(pdf, 10);

    expect(getPdfPageCount(offsetCopy.subarray(10))).toMatchInlineSnapshot(`
      {
        "pages": 3,
        "status": "ok",
      }
    `);
  });

  test('should use the newest page tree after an incremental update', () => {
    const base = buildPdf(flatPageTree(3));
    const updated = appendUpdate(base, {
      2: `<< /Type /Pages /Kids [${pageRefs(3, 3)} 6 0 R 7 0 R] /Count 5 >>`,
      6: page(2),
      7: page(2),
    });

    expect(getPdfPageCount(base.data)).toMatchInlineSnapshot(`
      {
        "pages": 3,
        "status": "ok",
      }
    `);
    expect(getPdfPageCount(updated.data)).toMatchInlineSnapshot(`
      {
        "pages": 5,
        "status": "ok",
      }
    `);
  });

  test('should count the pages an update removed from the tree', () => {
    const base = buildPdf(flatPageTree(2));
    const updated = appendUpdate(base, {
      2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    });

    expect(getPdfPageCount(updated.data)).toMatchInlineSnapshot(`
      {
        "pages": 1,
        "status": "ok",
      }
    `);
  });

  test('should read xref streams with and without compression', () => {
    expect(getPdfPageCount(buildPdf(flatPageTree(4), { xref: 'stream' }).data))
      .toMatchInlineSnapshot(`
        {
          "pages": 4,
          "status": "ok",
        }
      `);
    expect(
      getPdfPageCount(
        buildPdf(flatPageTree(4), { xref: 'stream', compressXref: true }).data,
      ),
    ).toMatchInlineSnapshot(`
      {
        "pages": 4,
        "status": "ok",
      }
    `);
  });

  test('should decode xref streams with PNG predictors', () => {
    let content = '%PDF-1.5\n';
    const offsets = [0];

    for (const body of [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
      page(2),
      page(2),
    ]) {
      offsets.push(content.length);
      content += `${offsets.length - 1} 0 obj\n${body}\nendobj\n`;
    }

    const xrefOffset = content.length;

    offsets.push(xrefOffset);

    const rows = offsets.map((offset, i) => [
      i === 0 ? 0 : 1,
      Math.floor(offset / 256),
      offset % 256,
      0,
    ]);
    // the rows cycle through the PNG filters (none, Sub, Up, Average, Paeth), which store each byte as the difference to a prediction from its neighbours
    const encodedRows = rows.flatMap((row, i) => {
      const filterType = i % 5;

      return [
        filterType,
        ...row.map((byte, j) => {
          const left = row[j - 1] ?? 0;
          const up = rows[i - 1]?.[j] ?? 0;
          const upLeft = rows[i - 1]?.[j - 1] ?? 0;

          return (
            (byte - pngPrediction(filterType, left, up, upLeft) + 256) % 256
          );
        }),
      ];
    });
    const xrefStream = stream(
      `/Type /XRef /Size ${offsets.length} /W [1 2 1] /Root 1 0 R /Filter /FlateDecode /DecodeParms << /Columns 4 /Predictor 12 >>`,
      deflateSync(Buffer.from(encodedRows)),
    );
    const pdf = Buffer.concat([
      Buffer.from(`${content}5 0 obj\n`, 'latin1'),
      xrefStream,
      Buffer.from(`\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`, 'latin1'),
    ]);

    expect(getPdfPageCount(pdf)).toMatchInlineSnapshot(`
      {
        "pages": 2,
        "status": "ok",
      }
    `);
  });

  test('should read hybrid files, with compressed objects listed by /XRefStm', () => {
    const pdf = buildPdf(
      {
        1: '<< /Type /Catalog /Pages 2 0 R >>',
        5: objectStream({
          2: '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
          3: page(2),
          4: page(2),
        }),
      },
      {
        xref: 'hybrid',
        compressed: {
          2: { objStm: 5, index: 0 },
          3: { objStm: 5, index: 1 },
          4: { objStm: 5, index: 2 },
        },
      },
    );

    expect(getPdfPageCount(pdf.data)).toMatchInlineSnapshot(`
      {
        "pages": 2,
        "status": "ok",
      }
    `);
  });

  test('should read hybrid files whose table lists compressed objects as free', () => {
    const pdf = buildPdf(
      {
        1: '<< /Type /Catalog /Pages 2 0 R >>',
        4: objectStream({
          2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
          3: page(2),
        }),
      },
      {
        xref: 'hybrid',
        hybridFreeEntries: true,
        compressed: {
          2: { objStm: 4, index: 0 },
          3: { objStm: 4, index: 1 },
        },
      },
    );

    expect(pdf.data.toString('latin1')).toContain('xref\n0 6\n');
    expect(getPdfPageCount(pdf.data)).toMatchInlineSnapshot(`
      {
        "pages": 1,
        "status": "ok",
      }
    `);
  });

  test('should read an update whose trailer copies the /XRefStm of the hybrid file it updates', () => {
    const base = buildPdf(
      {
        1: '<< /Type /Catalog /Pages 2 0 R >>',
        5: objectStream({
          2: '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
          3: page(2),
          4: page(2),
        }),
      },
      {
        xref: 'hybrid',
        compressed: {
          2: { objStm: 5, index: 0 },
          3: { objStm: 5, index: 1 },
          4: { objStm: 5, index: 2 },
        },
      },
    );
    const xrefStm = xrefStmRegex.exec(base.data.toString('latin1'))?.[1];
    const pdf = appendUpdate(
      base,
      { 3: page(2) },
      { trailer: `/Root 1 0 R /XRefStm ${xrefStm}` },
    );

    expect(xrefStm).toBeDefined();
    expect(getPdfPageCount(pdf.data, { maxXrefSections: 3 })).toEqual({
      status: 'ok',
      pages: 2,
    });
    // the copied /XRefStm is read once, so it counts as a single section
    expect(getPdfPageCount(pdf.data, { maxXrefSections: 2 })).toMatchObject({
      status: 'unsupported',
      reason: 'invalid_xref',
    });
  });

  test('should ignore a wrong Adler-32 checksum, like full parsers do', () => {
    const pdf = buildPdf(flatPageTree(2), {
      xref: 'stream',
      compressXref: true,
    });
    const data = Buffer.from(pdf.data);
    // the last byte of the zlib data is the end of the checksum
    const checksumEnd = data.lastIndexOf('\nendstream') - 1;

    data[checksumEnd] = (data[checksumEnd] ?? 0) ^ 0xff;

    expect(getPdfPageCount(data)).toEqual({ status: 'ok', pages: 2 });
  });

  test('should skip spaces between the stream keyword and its EOL', () => {
    const pdf = buildPdf(flatPageTree(2), {
      xref: 'stream',
      compressXref: true,
    });
    const text = pdf.data.toString('latin1');
    // the xref stream is the last object, so the inserted bytes move no offsets
    const keyword = text.lastIndexOf('stream\n');
    const data = Buffer.from(
      `${text.slice(0, keyword)}stream \t\r\n${text.slice(keyword + 'stream\n'.length)}`,
      'latin1',
    );

    expect(getPdfPageCount(data)).toEqual({ status: 'ok', pages: 2 });
  });

  test('should look up objects across many subsections', () => {
    const objects: Record<number, string> = {
      1: '<< /Type /Catalog /Pages 2 0 R >>',
    };
    const kids: string[] = [];

    // gaps between the objects make each one its own subsection
    for (let i = 0; i < 500; i++) {
      objects[10 + i * 3] = page(2);
      kids.push(`${10 + i * 3} 0 R`);
    }

    objects[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count 500 >>`;

    expect(getPdfPageCount(buildPdf(objects).data)).toMatchInlineSnapshot(`
      {
        "pages": 500,
        "status": "ok",
      }
    `);
    expect(getPdfPageCount(buildPdf(objects, { xref: 'stream' }).data))
      .toMatchInlineSnapshot(`
        {
          "pages": 500,
          "status": "ok",
        }
      `);
  });

  test('should count the leaves of nested page trees', () => {
    const pdf = buildPdf({
      1: '<< /Type /Catalog /Pages 2 0 R >>',
      2: '<< /Type /Pages /Kids [3 0 R 4 0 R 9 0 R] /Count 5 >>',
      3: '<< /Type /Pages /Parent 2 0 R /Kids [5 0 R 6 0 R] /Count 2 >>',
      // /Kids, /Type and /Count can be indirect
      4: '<< /Type 11 0 R /Parent 2 0 R /Kids 10 0 R /Count 2 >>',
      5: page(3),
      6: page(3),
      7: page(4),
      8: page(4),
      9: page(2),
      10: '[7 0 R 8 0 R]',
      11: '/Pages',
    });

    expect(getPdfPageCount(pdf.data)).toMatchInlineSnapshot(`
      {
        "pages": 5,
        "status": "ok",
      }
    `);
  });

  test('should resolve an indirect root /Count', () => {
    const pdf = buildPdf({
      ...flatPageTree(2),
      2: '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 5 0 R >>',
      5: '2',
    });

    expect(getPdfPageCount(pdf.data)).toMatchInlineSnapshot(`
      {
        "pages": 2,
        "status": "ok",
      }
    `);
  });

  test('should keep the declared start of subsections listing a freed object first', () => {
    const base = buildPdf(
      {
        1: '<< /Unused true >>',
        2: '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
        3: '<< /Type /Catalog /Pages 2 0 R >>',
        4: page(2),
      },
      { trailer: '/Root 3 0 R' },
    );
    // the update's table starts with the subsection `1 2`, listing the freed object 1 and then object 2
    const updated = appendUpdate(
      base,
      {
        2: '<< /Type /Pages /Kids [4 0 R 5 0 R] /Count 2 >>',
        5: page(2),
      },
      { trailer: '/Root 3 0 R', free: [1] },
    );

    expect(updated.data.toString('latin1')).toContain(
      'xref\n1 2\n0000000000 00001 f \n',
    );
    expect(getPdfPageCount(updated.data)).toMatchInlineSnapshot(`
      {
        "pages": 2,
        "status": "ok",
      }
    `);
  });

  test('should not look for the stream data of page tree nodes', () => {
    const pdf = buildPdf({
      ...flatPageTree(1),
      3: '<< /Type /Page /Parent 2 0 R >>\nstream\nno end keyword',
    });

    expect(getPdfPageCount(pdf.data)).toMatchInlineSnapshot(`
      {
        "detail": "Object 3 0 is a stream",
        "reason": "invalid_object",
        "status": "unsupported",
      }
    `);
  });

  test('should resolve the indirect /Length of object streams whose data contains the end keyword', () => {
    const pagesNode = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>\n';
    const header = `2 0 3 ${pagesNode.length}\n`;
    const decoded = Buffer.from(
      `${header}${pagesNode}<< /Type /Page /Parent 2 0 R /Title (endstream) >>\n`,
      'latin1',
    );
    const objectStreamBody = Buffer.concat([
      Buffer.from(
        `<< /Type /ObjStm /N 2 /First ${header.length} /Length 5 0 R >>\nstream\n`,
        'latin1',
      ),
      decoded,
      Buffer.from('\nendstream', 'latin1'),
    ]);
    const pdf = buildPdf(
      {
        1: '<< /Type /Catalog /Pages 2 0 R >>',
        4: objectStreamBody,
        5: String(decoded.length),
      },
      {
        xref: 'stream',
        compressed: { 2: { objStm: 4, index: 0 }, 3: { objStm: 4, index: 1 } },
      },
    );

    expect(getPdfPageCount(pdf.data)).toMatchInlineSnapshot(`
      {
        "pages": 1,
        "status": "ok",
      }
    `);
  });

  test('should parse shared indirect scalars once', () => {
    const pages = 100;
    const objects = flatPageTree(pages);

    // every page points to one /Type object with a lot of leading whitespace
    for (let i = 0; i < pages; i++) {
      objects[3 + i] = '<< /Type 200 0 R /Parent 2 0 R >>';
    }

    objects[200] = `${' '.repeat(10_000)}/Page`;

    const result = getPdfPageCount(buildPdf(objects).data, {
      maxInflatedBytes: 1_000,
    });

    expect(result).toMatchInlineSnapshot(`
      {
        "detail": "Xref table at 15826 needs 1304 bytes, over the 1000 bytes limit of decoded data",
        "reason": "too_large",
        "status": "rejected",
      }
    `);
  });

  test('should allow empty /Kids arrays shared by several nodes', () => {
    const pdf = buildPdf({
      1: '<< /Type /Catalog /Pages 2 0 R >>',
      2: '<< /Type /Pages /Kids [3 0 R 4 0 R 6 0 R] /Count 1 >>',
      3: '<< /Type /Pages /Parent 2 0 R /Kids 5 0 R /Count 0 >>',
      4: '<< /Type /Pages /Parent 2 0 R /Kids 5 0 R /Count 0 >>',
      5: '[]',
      6: page(2),
    });

    expect(getPdfPageCount(pdf.data)).toMatchInlineSnapshot(`
      {
        "pages": 1,
        "status": "ok",
      }
    `);
  });

  test('should parse a padded empty /Kids array shared by many nodes once', () => {
    const branches = 80;
    const objects: Record<number, string> = {
      1: '<< /Type /Catalog /Pages 2 0 R >>',
      2: `<< /Type /Pages /Kids [${pageRefs(10, branches)} 3 0 R] /Count 1 >>`,
      3: page(2),
      4: `${' '.repeat(10_000)}[]`,
    };

    for (let i = 0; i < branches; i++) {
      objects[10 + i] = '<< /Type /Pages /Parent 2 0 R /Kids 4 0 R /Count 0 >>';
    }

    const result = getPdfPageCount(buildPdf(objects).data, {
      maxInflatedBytes: 1_000,
    });

    expect(result).toMatchInlineSnapshot(`
      {
        "detail": "Xref table at 16364 needs 1076 bytes, over the 1000 bytes limit of decoded data",
        "reason": "too_large",
        "status": "rejected",
      }
    `);
  });

  test('should treat null dictionary entries as missing', async () => {
    const withObjectStreams = await createPdfLibPdf(2, true);
    const startxref = withObjectStreams
      .toString('latin1')
      .lastIndexOf('startxref');
    const base = {
      data: withObjectStreams,
      xrefOffset: Number(
        withObjectStreams
          .toString('latin1', startxref + 10)
          .split(whitespaceRegex)[0],
      ),
      size: 100,
    };

    // /Encrypt null doesn't make the file encrypted, and /Root null falls back to the older trailer's /Root
    expect(
      getPdfPageCount(
        appendUpdate(base, {}, { trailer: '/Encrypt null /Root null' }).data,
      ),
    ).toMatchInlineSnapshot(`
      {
        "pages": 2,
        "status": "ok",
      }
    `);
  });

  test('should walk deep page trees without recursion', () => {
    const depth = 20_000;
    const objects: Record<number, string> = {
      1: '<< /Type /Catalog /Pages 2 0 R >>',
    };

    for (let i = 0; i < depth; i++) {
      objects[2 + i] = `<< /Type /Pages /Kids [${3 + i} 0 R] /Count 1 >>`;
    }

    objects[2 + depth] = page(1 + depth);

    expect(getPdfPageCount(buildPdf(objects).data)).toMatchInlineSnapshot(`
      {
        "pages": 1,
        "status": "ok",
      }
    `);
  });

  test('should count documents with no pages', () => {
    expect(getPdfPageCount(buildPdf(flatPageTree(0)).data))
      .toMatchInlineSnapshot(`
        {
          "pages": 0,
          "status": "ok",
        }
      `);
  });

  test('should find the stream end when /Length is wrong or indirect', () => {
    const pdf = buildPdf(flatPageTree(2), { xref: 'stream' }).data.toString(
      'latin1',
    );
    const lengthEntry = lengthEntryRegex.exec(pdf)?.[0] ?? '';

    expect(lengthEntry).not.toBe('');

    for (const length of ['9999', '5 0 R', '2']) {
      const broken = pdf.replace(lengthEntry, `/Length ${length} >>\nstream`);

      expect(getPdfPageCount(Buffer.from(broken, 'latin1'))).toEqual({
        status: 'ok',
        pages: 2,
      });
    }
  });

  test('should read the uncompressed objects of encrypted files', () => {
    const pdf = buildPdf(flatPageTree(2), {
      trailer: '/Root 1 0 R /Encrypt << /Filter /Standard >>',
    });

    expect(getPdfPageCount(pdf.data)).toMatchInlineSnapshot(`
      {
        "pages": 2,
        "status": "ok",
      }
    `);
  });

  test('should match pdf-lib for the fixtures', async () => {
    const counts: Record<string, { reader: unknown; pdfLib: number }> = {};

    for (const file of [
      'invoice-sample.pdf',
      'receipt-sample.pdf',
      'report-design-reference.pdf',
    ]) {
      const data = readFileSync(`${import.meta.dirname}/fixtures/${file}`);
      const doc = await PDFDocument.load(data, { ignoreEncryption: true });

      counts[file] = {
        reader: getPdfPageCount(data),
        pdfLib: doc.getPageCount(),
      };
    }

    expect(counts).toMatchInlineSnapshot(`
      {
        "invoice-sample.pdf": {
          "pdfLib": 2,
          "reader": {
            "pages": 2,
            "status": "ok",
          },
        },
        "receipt-sample.pdf": {
          "pdfLib": 1,
          "reader": {
            "pages": 1,
            "status": "ok",
          },
        },
        "report-design-reference.pdf": {
          "pdfLib": 2,
          "reader": {
            "pages": 2,
            "status": "ok",
          },
        },
      }
    `);
  });

  test('should match pdf-lib for large generated documents', async () => {
    for (const useObjectStreams of [true, false]) {
      const pdf = await createPdfLibPdf(2_000, useObjectStreams);

      expect(getPdfPageCount(pdf)).toMatchInlineSnapshot(`
        {
          "pages": 2000,
          "status": "ok",
        }
      `);
    }
  });
});

describe('unsupported files', () => {
  test('should not read streams as page tree nodes', () => {
    const pdf = buildPdf({
      1: '<< /Type /Catalog /Pages 2 0 R >>',
      2: stream('/Type /Pages /Kids [3 0 R] /Count 1', ''),
      3: page(2),
    });

    expect(getPdfPageCount(pdf.data)).toMatchInlineSnapshot(`
      {
        "detail": "Object 2 0 is a stream",
        "reason": "invalid_object",
        "status": "unsupported",
      }
    `);
  });

  test('should not read files that are not PDFs', () => {
    expect(getPdfPageCount(Buffer.from('not a pdf'))).toMatchInlineSnapshot(`
      {
        "detail": "Missing startxref",
        "reason": "invalid_xref",
        "status": "unsupported",
      }
    `);
    expect(getPdfPageCount(new Uint8Array())).toMatchInlineSnapshot(`
      {
        "detail": "Missing startxref",
        "reason": "invalid_xref",
        "status": "unsupported",
      }
    `);
  });

  test('should refuse an update appended without its own startxref', () => {
    const base = buildPdf(flatPageTree(3));
    const updated = appendUpdate(base, {
      2: `<< /Type /Pages /Kids [${pageRefs(3, 3)} 6 0 R 7 0 R] /Count 5 >>`,
      6: page(2),
      7: page(2),
    });
    // cut before the update's startxref, so the last one left points to the base revision
    const cut = updated.data.subarray(0, updated.data.lastIndexOf('startxref'));

    expect(getPdfPageCount(cut)).toMatchInlineSnapshot(`
      {
        "detail": "Objects or xref data after the last startxref",
        "reason": "invalid_xref",
        "status": "unsupported",
      }
    `);
    expect(
      getPdfPageCount(
        Buffer.concat([base.data, Buffer.from('junk after the end\n')]),
      ),
    ).toEqual({ status: 'ok', pages: 3 });
  });

  test('should refuse xref streams with zero-width rows and a huge /Size', () => {
    const pdf = xrefStreamPdf('/Size 2000000000 /W [0 0 0]', Buffer.alloc(0));

    expect(getPdfPageCount(pdf)).toMatchInlineSnapshot(`
      {
        "detail": "Xref stream rows are empty",
        "reason": "invalid_xref",
        "status": "unsupported",
      }
    `);
  });

  test('should refuse xref streams with negative or oversized widths', () => {
    const rows = Buffer.alloc(8);

    expect(getPdfPageCount(xrefStreamPdf('/Size 2 /W [1 -2 1]', rows)))
      .toMatchInlineSnapshot(`
        {
          "detail": "Invalid xref stream /W",
          "reason": "invalid_xref",
          "status": "unsupported",
        }
      `);
    expect(getPdfPageCount(xrefStreamPdf('/Size 2 /W [1 9 1]', rows)))
      .toMatchInlineSnapshot(`
        {
          "detail": "Invalid xref stream /W",
          "reason": "invalid_xref",
          "status": "unsupported",
        }
      `);
  });

  test('should refuse xref streams whose /Index lists more entries than the data holds', () => {
    const rows = Buffer.alloc(8);

    expect(
      getPdfPageCount(
        xrefStreamPdf(
          '/Size 2000000000 /W [1 2 1] /Index [0 1000000000]',
          rows,
        ),
      ),
    ).toMatchInlineSnapshot(`
      {
        "detail": "The xref stream lists 1000000000 entries but has data for 2",
        "reason": "invalid_xref",
        "status": "unsupported",
      }
    `);
    expect(
      getPdfPageCount(
        xrefStreamPdf('/Size 3 /W [1 2 1] /Index [0 2 1 2]', Buffer.alloc(16)),
      ),
    ).toMatchInlineSnapshot(`
      {
        "detail": "Overlapping xref subsections",
        "reason": "invalid_xref",
        "status": "unsupported",
      }
    `);
  });

  test('should refuse xref tables whose subsection count exceeds the file', () => {
    const pdf = Buffer.from(
      '%PDF-1.4\nxref\n0 999999999\n0000000000 65535 f \ntrailer\n<< /Size 1 >>\nstartxref\n9\n%%EOF\n',
      'latin1',
    );

    expect(getPdfPageCount(pdf)).toMatchInlineSnapshot(`
      {
        "detail": "Xref subsection of 999999999 is truncated",
        "reason": "invalid_xref",
        "status": "unsupported",
      }
    `);
  });

  test('should refuse a cyclic /Prev chain', () => {
    const base = buildPdf(flatPageTree(1));
    const update = appendUpdate(base, { 3: page(2) });
    // the update's trailer is the last thing in the file, so pointing its /Prev at itself moves no offsets
    const cyclic = update.data
      .toString('latin1')
      .replace(`/Prev ${base.xrefOffset}`, `/Prev ${update.xrefOffset}`);

    expect(getPdfPageCount(Buffer.from(cyclic, 'latin1')))
      .toMatchInlineSnapshot(`
        {
          "detail": "The xref chain loops back to 400",
          "reason": "invalid_xref",
          "status": "unsupported",
        }
      `);
  });

  test('should refuse more xref sections than maxXrefSections', () => {
    let pdf = buildPdf(flatPageTree(1));

    for (let i = 0; i < 3; i++) pdf = appendUpdate(pdf, { 3: page(2) });

    expect(getPdfPageCount(pdf.data)).toMatchInlineSnapshot(`
      {
        "pages": 1,
        "status": "ok",
      }
    `);
    expect(getPdfPageCount(pdf.data, { maxXrefSections: 3 }))
      .toMatchInlineSnapshot(`
        {
          "detail": "More than 3 xref sections",
          "reason": "invalid_xref",
          "status": "unsupported",
        }
      `);
  });

  test('should refuse an xref offset that points to another object', () => {
    const pdf = buildPdf(flatPageTree(1));
    const text = pdf.data.toString('latin1');
    const pagesOffset = String(text.indexOf('2 0 obj')).padStart(10, '0');
    const catalogOffset = String(text.indexOf('1 0 obj')).padStart(10, '0');
    // the catalog entry now points to the /Pages object
    const broken = text.replace(
      `${catalogOffset} 00000 n \n${pagesOffset}`,
      `${pagesOffset} 00000 n \n${pagesOffset}`,
    );

    expect(broken).not.toBe(text);
    expect(getPdfPageCount(Buffer.from(broken, 'latin1')))
      .toMatchInlineSnapshot(`
        {
          "detail": "Expected object 1 0 at offset 58, found 2 0",
          "reason": "invalid_object",
          "status": "unsupported",
        }
      `);
  });

  test('should refuse an xref offset that points inside another object', () => {
    const pdf = buildPdf(flatPageTree(1));
    const text = pdf.data.toString('latin1');
    const catalogOffset = String(text.indexOf('1 0 obj')).padStart(10, '0');
    const pagesDictOffset = String(text.indexOf('<< /Type /Pages')).padStart(
      10,
      '0',
    );
    const broken = text.replace(
      `${catalogOffset} 00000 n`,
      `${pagesDictOffset} 00000 n`,
    );

    expect(broken).not.toBe(text);
    expect(getPdfPageCount(Buffer.from(broken, 'latin1')))
      .toMatchInlineSnapshot(`
        {
          "detail": "No indirect object at offset 66",
          "reason": "invalid_object",
          "status": "unsupported",
        }
      `);
  });

  test('should refuse an object stream index that holds another object', () => {
    const pdf = buildPdf(
      {
        1: '<< /Type /Catalog /Pages 2 0 R >>',
        4: objectStream({
          2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
          3: page(2),
        }),
      },
      {
        xref: 'stream',
        compressed: {
          2: { objStm: 4, index: 1 },
          3: { objStm: 4, index: 0 },
        },
      },
    );

    expect(getPdfPageCount(pdf.data)).toMatchInlineSnapshot(`
      {
        "detail": "Object 2 is not at index 1 of object stream 4",
        "reason": "invalid_object",
        "status": "unsupported",
      }
    `);
  });

  test('should refuse kids missing from the xref, which full parsers may find in the file body', async () => {
    const base = buildPdf({
      1: '<< /Type /Catalog /Pages 2 0 R >>',
      2: '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
      3: page(2),
    });
    // object 4 is written before the xref table, which doesn't list it
    const { xrefOffset } = base;
    const missingObject = Buffer.from(
      `4 0 obj\n${page(2)}\nendobj\n`,
      'latin1',
    );
    const pdf = Buffer.concat([
      base.data.subarray(0, xrefOffset),
      missingObject,
      Buffer.from(
        base.data
          .subarray(xrefOffset)
          .toString('latin1')
          .replace(
            `startxref\n${xrefOffset}`,
            `startxref\n${xrefOffset + missingObject.length}`,
          ),
        'latin1',
      ),
    ]);

    expect(getPdfPageCount(pdf)).toMatchInlineSnapshot(`
      {
        "detail": "Page tree node 4 0 R is not in the xref",
        "reason": "invalid_object",
        "status": "unsupported",
      }
    `);
    expect((await PDFDocument.load(pdf)).getPageCount()).toBe(2);
  });

  test('should refuse an indirect /Kids or /Count missing from the xref, which full parsers may find in the file body', () => {
    for (const pagesNode of [
      '<< /Type /Pages /Kids 5 0 R /Count 1 >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 5 0 R >>',
    ]) {
      const pdf = buildPdf({ ...flatPageTree(1), 2: pagesNode });

      expect(getPdfPageCount(pdf.data)).toMatchObject({
        status: 'unsupported',
        reason: 'invalid_object',
      });
    }
  });

  test('should refuse tokens longer than any keyword, name or number', () => {
    const pdf = buildPdf({
      ...flatPageTree(1),
      3: `<< /Type /Page /Parent 2 0 R /${'a'.repeat(70_000)} 1 >>`,
    });

    expect(getPdfPageCount(pdf.data)).toMatchInlineSnapshot(`
      {
        "detail": "A token at offset 153 is longer than 65536 bytes",
        "reason": "syntax_error",
        "status": "unsupported",
      }
    `);
  });

  test('should report broken xref sections as invalid_xref', () => {
    const pdf = buildPdf(flatPageTree(1));
    const text = pdf.data.toString('latin1');
    const withStartxref = (offset: string) =>
      Buffer.from(
        text.replace(`startxref\n${pdf.xrefOffset}`, `startxref\n${offset}`),
        'latin1',
      );

    expect(getPdfPageCount(withStartxref('abc'))).toMatchInlineSnapshot(`
      {
        "detail": "Invalid startxref offset",
        "reason": "invalid_xref",
        "status": "unsupported",
      }
    `);
    // inside the catalog object
    expect(getPdfPageCount(withStartxref('12'))).toMatchInlineSnapshot(`
      {
        "detail": "Invalid xref section at 12: No indirect object at offset 12",
        "reason": "invalid_xref",
        "status": "unsupported",
      }
    `);
    expect(
      getPdfPageCount(
        Buffer.from(text.replace('trailer', 'trailer2'), 'latin1'),
      ),
    ).toMatchInlineSnapshot(`
      {
        "detail": "Invalid xref section at 186: Expected an integer at offset 275",
        "reason": "invalid_xref",
        "status": "unsupported",
      }
    `);
  });

  test('should refuse page tree nodes without a /Type name, which full parsers skip', () => {
    for (const kid of ['<< >>', '<< /Type (Page) >>', '<< /Kids [] >>']) {
      const pdf = buildPdf({ ...flatPageTree(1), 3: kid });

      expect(getPdfPageCount(pdf.data)).toMatchObject({
        status: 'unsupported',
        reason: 'invalid_object',
      });
    }
  });

  test('should read object stream headers only up to /First', () => {
    // /N claims 2 pairs but the header holds 1, and the object data after /First looks like another pair
    const decoded = '3 0 \n4 0 << /Type /Page >>';
    const pdf = buildPdf(
      {
        1: '<< /Type /Catalog /Pages 2 0 R >>',
        2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        5: stream(
          '/Type /ObjStm /N 2 /First 5 /Filter /FlateDecode',
          deflateSync(Buffer.from(decoded, 'latin1')),
        ),
      },
      { xref: 'stream', compressed: { 3: { objStm: 5, index: 0 } } },
    );

    expect(getPdfPageCount(pdf.data)).toMatchInlineSnapshot(`
      {
        "detail": "Expected an integer at offset 5",
        "reason": "syntax_error",
        "status": "unsupported",
      }
    `);
  });

  test('should not allocate for an object stream /N its header does not hold', () => {
    const pdf = buildPdf(
      {
        1: '<< /Type /Catalog /Pages 2 0 R >>',
        3: stream(
          '/Type /ObjStm /N 8000000 /First 32000000 /Filter /FlateDecode',
          deflateSync(Buffer.alloc(32_000_100, 0x20)),
        ),
      },
      { xref: 'stream', compressed: { 2: { objStm: 3, index: 0 } } },
    );
    const before = process.memoryUsage().arrayBuffers;
    const result = getPdfPageCount(pdf.data);
    // the decoded stream takes 32 MB, the header arrays for /N would take 128 MB more
    const allocated = process.memoryUsage().arrayBuffers - before;

    expect(pdf.data.length).toBeLessThan(100_000);
    expect(allocated).toBeLessThan(80_000_000);
    expect(result).toMatchInlineSnapshot(`
      {
        "detail": "Expected an integer at offset 32000000",
        "reason": "syntax_error",
        "status": "unsupported",
      }
    `);
  });

  test('should parse long numeric tokens in linear time', () => {
    const pdf = buildPdf({
      ...flatPageTree(1),
      3: `<< /Type /Page /Parent 2 0 R /X ${'1'.repeat(200_000)}x >>`,
    });
    const start = performance.now();

    expect(getPdfPageCount(pdf.data).status).toBe('unsupported');
    expect(performance.now() - start).toBeLessThan(1_000);
  });

  test('should report a detached input buffer instead of throwing', () => {
    const input = new Uint8Array(new ArrayBuffer(16));

    structuredClone(input.buffer, { transfer: [input.buffer] });

    expect(getPdfPageCount(input)).toMatchObject({
      status: 'unsupported',
      reason: 'unexpected_error',
    });
  });

  test('should refuse a /Root that is not a /Catalog', () => {
    const pdf = buildPdf(
      {
        ...flatPageTree(5),
        // a decoy the trailer points to, with an empty page tree
        9: '<< /Pages 10 0 R >>',
        10: '<< /Type /Pages /Kids [] /Count 0 >>',
      },
      { trailer: '/Root 9 0 R' },
    );

    expect(getPdfPageCount(pdf.data)).toMatchInlineSnapshot(`
      {
        "detail": "The /Root is not a /Catalog dictionary",
        "reason": "invalid_object",
        "status": "unsupported",
      }
    `);
  });

  test('should refuse filters other than FlateDecode', () => {
    const pdf = xrefStreamPdf(
      '/Size 2 /W [1 2 1] /Filter /LZWDecode',
      Buffer.alloc(8),
    );

    expect(getPdfPageCount(pdf)).toMatchInlineSnapshot(`
      {
        "detail": "Unsupported stream filter LZWDecode",
        "reason": "unsupported_filter",
        "status": "unsupported",
      }
    `);
  });

  test('should refuse corrupt FlateDecode data', () => {
    const pdf = xrefStreamPdf(
      '/Size 2 /W [1 2 1] /Filter /FlateDecode',
      Buffer.from('not zlib data'),
    );

    expect(getPdfPageCount(pdf)).toMatchInlineSnapshot(`
      {
        "detail": "incorrect header check",
        "reason": "invalid_stream",
        "status": "unsupported",
      }
    `);
  });

  test('should refuse /DecodeParms it cannot read instead of skipping them', () => {
    const rows = deflateSync(Buffer.alloc(8));

    expect(
      getPdfPageCount(
        xrefStreamPdf(
          '/Size 2 /W [1 2 1] /Filter /FlateDecode /DecodeParms 6 0 R',
          rows,
        ),
      ),
    ).toMatchInlineSnapshot(`
      {
        "detail": "/DecodeParms is not a dictionary",
        "reason": "unsupported_filter",
        "status": "unsupported",
      }
    `);
    expect(
      getPdfPageCount(
        xrefStreamPdf(
          '/Size 2 /W [1 2 1] /Filter /FlateDecode /DecodeParms [6 0 R]',
          rows,
        ),
      ),
    ).toMatchInlineSnapshot(`
      {
        "detail": "/DecodeParms is not a dictionary",
        "reason": "unsupported_filter",
        "status": "unsupported",
      }
    `);
    expect(
      getPdfPageCount(
        xrefStreamPdf(
          '/Size 2 /W [1 2 1] /Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns -4 >>',
          rows,
        ),
      ),
    ).toMatchInlineSnapshot(`
      {
        "detail": "Invalid /DecodeParms /Columns",
        "reason": "unsupported_filter",
        "status": "unsupported",
      }
    `);
  });

  test('should refuse PNG predictor rows with an invalid filter type', () => {
    const pdf = xrefStreamPdf(
      '/Size 2 /W [1 2 1] /Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 4 >>',
      deflateSync(Buffer.from([7, 0, 0, 0, 0, 7, 1, 0, 9, 0])),
    );

    expect(getPdfPageCount(pdf)).toMatchInlineSnapshot(`
      {
        "detail": "Invalid PNG predictor row",
        "reason": "invalid_stream",
        "status": "unsupported",
      }
    `);
  });

  test('should refuse object streams of encrypted files', async () => {
    const data = await createPdfLibPdf(2, true);
    const startxref = data.toString('latin1').lastIndexOf('startxref');
    const xrefOffset = Number(
      data.toString('latin1', startxref + 10).split(whitespaceRegex)[0],
    );
    const encrypted = appendUpdate(
      { data, xrefOffset, size: 100 },
      {},
      { trailer: '/Encrypt << /Filter /Standard >>' },
    );

    expect(getPdfPageCount(encrypted.data)).toMatchInlineSnapshot(`
      {
        "detail": "Object 2 is in an object stream of an encrypted file",
        "reason": "encrypted",
        "status": "unsupported",
      }
    `);
  });
});

describe('rejected files', () => {
  test('should reject a compression bomb with the default limit', () => {
    const pdf = buildPdf(
      {
        1: '<< /Type /Catalog /Pages 2 0 R >>',
        3: objectStream(
          { 2: '<< /Type /Pages /Kids [] /Count 0 >>' },
          { padding: 64 * 1024 * 1024 },
        ),
      },
      { xref: 'stream', compressed: { 2: { objStm: 3, index: 0 } } },
    );

    expect(pdf.data.length).toBeLessThan(200_000);
    expect(getPdfPageCount(pdf.data)).toMatchInlineSnapshot(`
      {
        "detail": "Decoded streams exceed 33554432 bytes",
        "reason": "too_large",
        "status": "rejected",
      }
    `);

    // invalid limits fall back to the default instead of disabling the check
    for (const maxInflatedBytes of [NaN, Infinity, 0, -1, 1.5]) {
      expect(getPdfPageCount(pdf.data, { maxInflatedBytes })).toEqual(
        getPdfPageCount(pdf.data),
      );
    }
  });

  test('should use the default for invalid tree and xref limits', () => {
    const tree = buildPdf(flatPageTree(3), {
      trailer: '/Root 1 0 R',
    }).data;
    const cyclic = Buffer.from(
      tree
        .toString('latin1')
        .replace(
          '/Root 1 0 R',
          `/Root 1 0 R /Prev ${tree.toString('latin1').lastIndexOf('xref')}`,
        ),
      'latin1',
    );

    for (const limit of [NaN, Infinity, 0, -1, 1.5]) {
      expect(
        getPdfPageCount(buildPdf(flatPageTree(3, { count: 3 })).data, {
          maxTreeNodes: limit,
        }),
      ).toEqual({ status: 'ok', pages: 3 });
      expect(getPdfPageCount(cyclic, { maxXrefSections: limit }).status).toBe(
        'unsupported',
      );
    }
  });

  test('should count every decoded stream against maxInflatedBytes', () => {
    const pdf = buildPdf(
      {
        1: '<< /Type /Catalog /Pages 2 0 R >>',
        4: objectStream(
          { 2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
          { padding: 600_000 },
        ),
        5: objectStream({ 3: page(2) }, { padding: 600_000 }),
      },
      {
        xref: 'stream',
        compressXref: true,
        compressed: { 2: { objStm: 4, index: 0 }, 3: { objStm: 5, index: 0 } },
      },
    );

    expect(getPdfPageCount(pdf.data, { maxInflatedBytes: 2_000_000 }))
      .toMatchInlineSnapshot(`
        {
          "pages": 1,
          "status": "ok",
        }
      `);
    expect(getPdfPageCount(pdf.data, { maxInflatedBytes: 1_000_000 }))
      .toMatchInlineSnapshot(`
        {
          "detail": "Decoded streams exceed 1000000 bytes",
          "reason": "too_large",
          "status": "rejected",
        }
      `);
  });

  test('should reject objects too large to parse', () => {
    const pdf = buildPdf({
      1: '<< /Type /Catalog /Pages 2 0 R >>',
      2: `<< /Type /Pages /Kids [${'3 0 R '.repeat(1_000_001)}] /Count 1 >>`,
      3: page(2),
    });

    expect(getPdfPageCount(pdf.data)).toMatchInlineSnapshot(`
      {
        "detail": "An object has more than 1000000 values",
        "reason": "too_large",
        "status": "rejected",
      }
    `);
  });

  test('should reject object streams whose objects share an offset', () => {
    const kids = Array.from({ length: 50 }, (_, i) => `${10 + i} 0 R`);
    const header = kids.map((_, i) => `${10 + i} 0`).join(' ');
    const sharedPage = `<< /Type /Page /Padding [${'0 '.repeat(10_000)}] >>`;
    const decoded = `${header}\n${sharedPage}`;
    const compressed: Record<number, { objStm: number; index: number }> = {};

    for (let i = 0; i < kids.length; i++) {
      compressed[10 + i] = { objStm: 3, index: i };
    }

    const pdf = buildPdf(
      {
        1: '<< /Type /Catalog /Pages 2 0 R >>',
        2: `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`,
        3: stream(
          `/Type /ObjStm /N ${kids.length} /First ${header.length + 1} /Filter /FlateDecode`,
          deflateSync(Buffer.from(decoded, 'latin1')),
        ),
      },
      { xref: 'stream', compressed },
    );

    expect(getPdfPageCount(pdf.data)).toMatchInlineSnapshot(`
      {
        "detail": "Object stream 3 has two objects at offset 0",
        "reason": "overlapping_objects",
        "status": "rejected",
      }
    `);
  });

  test('should reject object stream offsets that run into the next object', () => {
    const sharedPage = `<< /Type /Page /Padding [${'0 '.repeat(10_000)}] >>`;

    /** the first `pages` objects are the kids of the page tree */
    function objectStreamPdf(
      offsets: number[],
      objectsData: string,
      pages = offsets.length,
    ) {
      const kids = offsets.slice(0, pages).map((_, i) => `${10 + i} 0 R`);
      const header = offsets
        .map((offset, i) => `${10 + i} ${offset}`)
        .join(' ');
      const compressed: Record<number, { objStm: number; index: number }> = {};

      for (let i = 0; i < offsets.length; i++) {
        compressed[10 + i] = { objStm: 3, index: i };
      }

      return buildPdf(
        {
          1: '<< /Type /Catalog /Pages 2 0 R >>',
          2: `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`,
          3: stream(
            `/Type /ObjStm /N ${offsets.length} /First ${header.length + 1} /Filter /FlateDecode`,
            deflateSync(Buffer.from(`${header}\n${objectsData}`, 'latin1')),
          ),
        },
        { xref: 'stream', compressed },
      ).data;
    }

    const whitespaceOffsets = Array.from({ length: 50 }, (_, i) => i);

    // distinct offsets in the whitespace before one large object
    expect(
      getPdfPageCount(
        objectStreamPdf(whitespaceOffsets, `${' '.repeat(49)}${sharedPage}`),
      ),
    ).toMatchInlineSnapshot(`
      {
        "detail": "Parsing read more than 44114 bytes, so objects overlap",
        "reason": "overlapping_objects",
        "status": "rejected",
      }
    `);
    // an offset inside a page tree object cuts it off
    expect(getPdfPageCount(objectStreamPdf([0, 20], sharedPage, 1)))
      .toMatchInlineSnapshot(`
        {
          "detail": "Object 10 of object stream 3 runs into the object at offset 20",
          "reason": "overlapping_objects",
          "status": "rejected",
        }
      `);
    // a truncated last object has no next object to overlap
    expect(getPdfPageCount(objectStreamPdf([0], sharedPage.slice(0, 50))))
      .toMatchInlineSnapshot(`
        {
          "detail": "Unterminated array",
          "reason": "syntax_error",
          "status": "unsupported",
        }
      `);
  });

  test('should reject objects nested in the strings of other objects', () => {
    const pages = 200;
    let nested = '';

    // each page holds the next ones in a string, so reading every page would walk the rest of the file again
    for (let num = 2 + pages; num > 2; num--) {
      nested = `${num} 0 obj << /Type /Page /Parent 2 0 R /Next (${nested}) >>`;
    }

    const content = `%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [${pageRefs(3, pages)}] /Count ${pages} >> endobj\n${nested} endobj\n`;
    const offsets = Array.from({ length: pages + 2 }, (_, i) =>
      content.indexOf(`${i + 1} 0 obj`),
    );
    const xrefOffset = content.length;
    const table = offsets
      .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
      .join('');
    const pdf = Buffer.from(
      `${content}xref\n0 ${pages + 3}\n0000000000 65535 f \n${table}trailer\n<< /Size ${pages + 3} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
      'latin1',
    );

    expect(getPdfPageCount(pdf, { maxInflatedBytes: 1_000 }))
      .toMatchInlineSnapshot(`
        {
          "detail": "Xref table at 11511 needs 2464 bytes, over the 1000 bytes limit of decoded data",
          "reason": "too_large",
          "status": "rejected",
        }
      `);
  });

  test('should reject object stream headers needing more array memory than the limit', () => {
    const pairs = 4_000_000;
    // tiny repeated pairs, which pass the header parse but need 20 bytes each in arrays
    const header = '1 0 '.repeat(pairs);
    const pdf = buildPdf(
      {
        1: '<< /Type /Catalog /Pages 2 0 R >>',
        3: stream(
          `/Type /ObjStm /N ${pairs} /First ${header.length} /Filter /FlateDecode`,
          deflateSync(Buffer.from(`${header}<< >>`, 'latin1')),
        ),
      },
      { xref: 'stream', compressed: { 2: { objStm: 3, index: 0 } } },
    );
    const before = process.memoryUsage().arrayBuffers;
    const result = getPdfPageCount(pdf.data);
    // the decoded stream takes 16 MB, the header arrays would take 80 MB more
    const allocated = process.memoryUsage().arrayBuffers - before;

    expect(pdf.data.length).toBeLessThan(100_000);
    expect(allocated).toBeLessThan(50_000_000);
    expect(result).toMatchInlineSnapshot(`
      {
        "detail": "Object stream 3 header needs 80000000 bytes, over the 33554432 bytes limit of decoded data",
        "reason": "too_large",
        "status": "rejected",
      }
    `);
  });

  test('should reject objects nested deeper than full parsers can handle', () => {
    const pdf = buildPdf({
      ...flatPageTree(1),
      3: `<< /Type /Page /Parent 2 0 R /X ${'['.repeat(10_000)}${']'.repeat(10_000)} >>`,
    });

    expect(getPdfPageCount(pdf.data)).toMatchInlineSnapshot(`
      {
        "detail": "Nesting deeper than 100",
        "reason": "too_large",
        "status": "rejected",
      }
    `);
  });

  test('should reject object stream tokens cut by the next object offset', () => {
    // object 5 would read `1` from `1000`, and object 6 the rest
    const pdf = buildPdf(
      {
        1: '<< /Type /Catalog /Pages 2 0 R >>',
        2: '<< /Type /Pages /Kids [3 0 R] /Count 5 0 R >>',
        3: page(2),
        4: stream(
          '/Type /ObjStm /N 2 /First 8 /Filter /FlateDecode',
          deflateSync(Buffer.from('5 0 6 1\n1000', 'latin1')),
        ),
      },
      {
        xref: 'stream',
        compressed: { 5: { objStm: 4, index: 0 }, 6: { objStm: 4, index: 1 } },
      },
    );

    expect(getPdfPageCount(pdf.data)).toMatchInlineSnapshot(`
      {
        "detail": "Object 5 of object stream 4 runs into the object at offset 1",
        "reason": "overlapping_objects",
        "status": "rejected",
      }
    `);
  });

  test('should reject object stream references split by the next object offset', () => {
    // object 5 would read `1` from `1 0 R`, and object 6 the rest
    const pdf = buildPdf(
      {
        1: '<< /Type /Catalog /Pages 2 0 R >>',
        2: '<< /Type /Pages /Kids [3 0 R] /Count 5 0 R >>',
        3: page(2),
        4: stream(
          '/Type /ObjStm /N 2 /First 8 /Filter /FlateDecode',
          deflateSync(Buffer.from('5 0 6 2\n1 0 R', 'latin1')),
        ),
      },
      {
        xref: 'stream',
        compressed: { 5: { objStm: 4, index: 0 }, 6: { objStm: 4, index: 1 } },
      },
    );

    expect(getPdfPageCount(pdf.data)).toMatchInlineSnapshot(`
      {
        "detail": "Object 5 of object stream 4 runs into the object at offset 2",
        "reason": "overlapping_objects",
        "status": "rejected",
      }
    `);
  });

  test('should ignore an unneeded object stream object that runs into the next one', () => {
    // an unbalanced parenthesis makes the title string run into the author object
    const pdf = buildPdf(
      {
        4: objectStream({
          1: '<< /Type /Catalog /Pages 2 0 R >>',
          2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
          3: page(2),
          5: '<< /Title (broken ( title) >>',
          6: '<< /Author (author) (keywords) >>',
        }),
      },
      {
        xref: 'stream',
        compressed: {
          1: { objStm: 4, index: 0 },
          2: { objStm: 4, index: 1 },
          3: { objStm: 4, index: 2 },
          5: { objStm: 4, index: 3 },
          6: { objStm: 4, index: 4 },
        },
        trailer: '/Root 1 0 R /Info 5 0 R',
      },
    );

    expect(getPdfPageCount(pdf.data)).toEqual({ status: 'ok', pages: 1 });
  });

  test('should ignore an unneeded object stream object nested too deep', () => {
    const pdf = buildPdf(
      {
        4: objectStream({
          1: '<< /Type /Catalog /Pages 2 0 R >>',
          2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
          3: page(2),
          5: `${'['.repeat(150)}${']'.repeat(150)}`,
        }),
      },
      {
        xref: 'stream',
        compressed: {
          1: { objStm: 4, index: 0 },
          2: { objStm: 4, index: 1 },
          3: { objStm: 4, index: 2 },
          5: { objStm: 4, index: 3 },
        },
        trailer: '/Root 1 0 R',
      },
    );

    expect(getPdfPageCount(pdf.data)).toEqual({ status: 'ok', pages: 1 });
  });

  test('should read object stream objects that end right at the next offset', () => {
    // the values end at delimiters, so parsing past the offsets would read nothing more
    const pdf = buildPdf(
      {
        1: '<< /Type /Catalog /Pages 2 0 R >>',
        2: '<< /Type /Pages /Kids [3 0 R] /Count 5 0 R >>',
        3: page(2),
        4: stream(
          '/Type /ObjStm /N 3 /First 12 /Filter /FlateDecode',
          deflateSync(Buffer.from('5 0 6 1 7 5\n1<<>>/Name', 'latin1')),
        ),
      },
      {
        xref: 'stream',
        compressed: {
          5: { objStm: 4, index: 0 },
          6: { objStm: 4, index: 1 },
          7: { objStm: 4, index: 2 },
        },
      },
    );

    expect(getPdfPageCount(pdf.data)).toEqual({ status: 'ok', pages: 1 });
  });

  test('should charge reference lookaheads to the parse budget', () => {
    // each `1` looks ahead through a comment that holds every later object, which made reading them quadratic
    const objectsCount = 20_000;
    const nums = Array.from({ length: objectsCount }, (_, i) => 5 + i);
    const header = nums
      .map((objectNum, i) => `${objectNum} ${i * 3}`)
      .join(' ');
    const pdf = buildPdf(
      {
        1: '<< /Type /Catalog /Pages 2 0 R >>',
        2: '<< /Type /Pages /Kids [3 0 R] /Count 5 0 R >>',
        3: page(2),
        4: stream(
          `/Type /ObjStm /N ${objectsCount} /First ${header.length + 1} /Filter /FlateDecode`,
          deflateSync(
            Buffer.from(`${header}\n${'1 %'.repeat(objectsCount)}`, 'latin1'),
          ),
        ),
      },
      { xref: 'stream', compressed: { 5: { objStm: 4, index: 0 } } },
    );

    const start = performance.now();
    const result = getPdfPageCount(pdf.data);

    expect(performance.now() - start).toBeLessThan(1000);
    expect(result).toMatchInlineSnapshot(`
      {
        "detail": "Parsing read more than 747622 bytes, so objects overlap",
        "reason": "overlapping_objects",
        "status": "rejected",
      }
    `);
  });

  test('should limit the parse budget to the data actually decoded', () => {
    const nesting = 99;
    const body = `${'['.repeat(nesting)}${'0 '.repeat(500_000)}${']'.repeat(nesting)}`;
    // every object starts at a different bracket of the same nested array, so each one walks all of it
    const header = Array.from(
      { length: nesting },
      (_, i) => `${10 + i} ${i}`,
    ).join(' ');
    const compressed: Record<number, { objStm: number; index: number }> = {};

    for (let i = 0; i < nesting; i++) {
      compressed[10 + i] = { objStm: 3, index: i };
    }

    const pdf = buildPdf(
      {
        1: '<< /Type /Catalog /Pages 2 0 R >>',
        2: '<< /Type /Pages /Kids [10 0 R] /Count 1 >>',
        3: stream(
          `/Type /ObjStm /N ${nesting} /First ${header.length + 1} /Filter /FlateDecode`,
          deflateSync(Buffer.from(`${header}\n${body}`, 'latin1')),
        ),
      },
      { xref: 'stream', compressed },
    );

    const start = performance.now();
    const result = getPdfPageCount(pdf.data);

    expect(pdf.data.length).toBeLessThan(5_000);
    expect(performance.now() - start).toBeLessThan(500);
    expect(result).toMatchInlineSnapshot(`
      {
        "detail": "Parsing read more than 2007748 bytes, so objects overlap",
        "reason": "overlapping_objects",
        "status": "rejected",
      }
    `);
  });

  test('should drop empty xref subsections', () => {
    const pdf = buildPdf(flatPageTree(1));
    const data = Buffer.from(
      pdf.data
        .toString('latin1')
        .replace('xref\n', `xref\n${'5 0\n'.repeat(100_000)}`),
      'latin1',
    );

    // indexing the empty subsections would need 2.8 MB
    expect(getPdfPageCount(data, { maxInflatedBytes: 1000 })).toEqual({
      status: 'ok',
      pages: 1,
    });
  });

  test('should charge xref table arrays to maxInflatedBytes', () => {
    const pdf = buildPdf(flatPageTree(100));

    expect(getPdfPageCount(pdf.data)).toEqual({ status: 'ok', pages: 100 });
    expect(getPdfPageCount(pdf.data, { maxInflatedBytes: 1000 }))
      .toMatchInlineSnapshot(`
        {
          "detail": "Xref table at 8003 needs 1264 bytes, over the 1000 bytes limit of decoded data",
          "reason": "too_large",
          "status": "rejected",
        }
      `);
  });

  test('should charge xref stream /Index arrays to maxInflatedBytes', () => {
    const pdf = buildPdf(flatPageTree(1), { xref: 'stream' });
    // single-object subsections, as many as the rows allow
    const data = Buffer.from(
      pdf.data
        .toString('latin1')
        .replace(indexEntryRegex, '/Index [0 1 1 1 2 1 3 1 4 1]'),
      'latin1',
    );

    expect(getPdfPageCount(data)).toEqual({ status: 'ok', pages: 1 });
    expect(getPdfPageCount(data, { maxInflatedBytes: 100 }))
      .toMatchInlineSnapshot(`
        {
          "detail": "Xref stream at 186 /Index needs 140 bytes, over the 100 bytes limit of decoded data",
          "reason": "too_large",
          "status": "rejected",
        }
      `);
  });

  test('should charge the scan for the stream end keyword to the parse budget', () => {
    const padding = 100_000;
    const pad = (value: number) => String(value).padStart(10, '0');

    function decoysPdf(decoys: number): Buffer {
      let content = '%PDF-1.7\n';
      const offsets: number[] = [];

      for (const body of [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        page(2),
      ]) {
        offsets.push(content.length);
        content += `${offsets.length} 0 obj\n${body}\nendobj\n`;
      }

      const tableOffset = content.length;

      content += `xref\n0 4\n0000000000 65535 f \n${offsets.map((offset) => `${pad(offset)} 00000 n \n`).join('')}trailer\n<< /Size 4 /Root 1 0 R >>\n`;

      // every decoy xref stream's /Length ends at the same whitespace block, so each one scans all of it for `endstream`
      const decoyOffsets: number[] = [];
      const lengthPlaceholders: number[] = [];

      for (let i = 0; i < decoys; i++) {
        decoyOffsets.push(content.length);
        content += `${10 + i} 0 obj\n<< /Type /XRef /Size 2000 /W [1 1 1] /Index [1000 1] /Prev ${pad(i === 0 ? tableOffset : (decoyOffsets[i - 1] ?? 0))} /Length `;
        lengthPlaceholders.push(content.length);
        content += `${pad(0)} >>\nstream\n`;
      }

      // the row every decoy's data ends with
      content += '\x00\x00\x00';

      const paddingStart = content.length;

      content += `${' '.repeat(padding)}endstream\nendobj\nstartxref\n${decoyOffsets.at(-1)}\n%%EOF\n`;

      for (const placeholder of lengthPlaceholders) {
        const dataStart = placeholder + 10 + ' >>\nstream\n'.length;

        content =
          content.slice(0, placeholder) +
          pad(paddingStart - dataStart) +
          content.slice(placeholder + 10);
      }

      return Buffer.from(content, 'latin1');
    }

    // a single scan of the padding is within the budget of a valid file
    expect(getPdfPageCount(decoysPdf(1))).toMatchObject({
      status: 'ok',
      pages: 1,
    });
    expect(getPdfPageCount(decoysPdf(5))).toMatchInlineSnapshot(`
      {
        "detail": "Parsing read more than 202006 bytes, so objects overlap",
        "reason": "overlapping_objects",
        "status": "rejected",
      }
    `);
  });

  test('should reject cycles in /Kids', () => {
    const pdf = buildPdf({
      1: '<< /Type /Catalog /Pages 2 0 R >>',
      2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      3: '<< /Type /Pages /Kids [2 0 R] /Count 1 >>',
    });

    expect(getPdfPageCount(pdf.data)).toMatchInlineSnapshot(`
      {
        "detail": "A page tree node (object 2) appears more than once in the page tree",
        "reason": "malformed_tree",
        "status": "rejected",
      }
    `);
  });

  test('should reject pages listed twice', () => {
    const pdf = buildPdf({
      1: '<< /Type /Catalog /Pages 2 0 R >>',
      2: '<< /Type /Pages /Kids [3 0 R 3 0 R] /Count 2 >>',
      3: page(2),
    });

    expect(getPdfPageCount(pdf.data)).toMatchInlineSnapshot(`
      {
        "detail": "A page tree node (object 3) appears more than once in the page tree",
        "reason": "malformed_tree",
        "status": "rejected",
      }
    `);
  });

  test('should reject /Kids arrays shared by several nodes', () => {
    const pdf = buildPdf({
      1: '<< /Type /Catalog /Pages 2 0 R >>',
      2: '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
      3: '<< /Type /Pages /Kids 5 0 R /Count 1 >>',
      4: '<< /Type /Pages /Kids 5 0 R /Count 1 >>',
      5: `[<< /Type /Page /MediaBox [0 0 612 792] >>]`,
    });

    expect(getPdfPageCount(pdf.data)).toMatchInlineSnapshot(`
      {
        "detail": "A /Kids array (object 5) appears more than once in the page tree",
        "reason": "malformed_tree",
        "status": "rejected",
      }
    `);
  });

  test('should reject a /Count that disagrees with the kids', () => {
    expect(getPdfPageCount(buildPdf(flatPageTree(2, { count: 1000 })).data))
      .toMatchInlineSnapshot(`
        {
          "detail": "The page tree has 2 pages but its /Count is 1000",
          "reason": "count_mismatch",
          "status": "rejected",
        }
      `);
    expect(getPdfPageCount(buildPdf(flatPageTree(3, { count: 1 })).data))
      .toMatchInlineSnapshot(`
        {
          "detail": "The page tree has 3 pages but its /Count is 1",
          "reason": "count_mismatch",
          "status": "rejected",
        }
      `);
  });

  test('should reject page trees larger than maxTreeNodes', () => {
    const pdf = buildPdf(flatPageTree(20));

    expect(getPdfPageCount(pdf.data, { maxTreeNodes: 21 }))
      .toMatchInlineSnapshot(`
        {
          "pages": 20,
          "status": "ok",
        }
      `);
    expect(getPdfPageCount(pdf.data, { maxTreeNodes: 20 }))
      .toMatchInlineSnapshot(`
        {
          "detail": "The page tree has more than 20 nodes",
          "reason": "too_many_nodes",
          "status": "rejected",
        }
      `);
  });

  test('should reject kids that are not page tree nodes', () => {
    expect(
      getPdfPageCount(
        buildPdf({
          1: '<< /Type /Catalog /Pages 2 0 R >>',
          2: '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
          3: page(2),
          4: '[]',
        }).data,
      ),
    ).toMatchInlineSnapshot(`
      {
        "detail": "Page tree node 4 0 R is not a dictionary",
        "reason": "malformed_tree",
        "status": "rejected",
      }
    `);
    expect(
      getPdfPageCount(
        buildPdf({
          1: '<< /Type /Catalog /Pages 2 0 R >>',
          2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
          3: '<< /Type /Font >>',
        }).data,
      ),
    ).toMatchInlineSnapshot(`
      {
        "detail": "Invalid page tree node type /Font",
        "reason": "malformed_tree",
        "status": "rejected",
      }
    `);
    expect(
      getPdfPageCount(
        buildPdf({
          1: '<< /Type /Catalog /Pages 2 0 R >>',
          2: page(1),
        }).data,
      ),
    ).toMatchInlineSnapshot(`
      {
        "detail": "The page tree root is not a /Pages node",
        "reason": "malformed_tree",
        "status": "rejected",
      }
    `);
  });
});

function pngPrediction(
  filterType: number,
  left: number,
  up: number,
  upLeft: number,
): number {
  if (filterType === 1) return left;
  if (filterType === 2) return up;
  if (filterType === 3) return Math.floor((left + up) / 2);
  if (filterType !== 4) return 0;

  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upLeftDistance = Math.abs(estimate - upLeft);

  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) return left;

  return upDistance <= upLeftDistance ? up : upLeft;
}
