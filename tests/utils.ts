import { deflateSync } from 'node:zlib';
import { PDFDocument } from 'pdf-lib';

/** object number → body written between `num 0 obj` and `endobj` */
export type PdfObjects = Record<number, string | Buffer>;

export type PdfFile = { data: Buffer; xrefOffset: number; size: number };

type CompressedEntry = { objStm: number; index: number };

type SectionOptions = {
  /**
   * - `table`: an xref table
   * - `stream`: an xref stream listing every object
   * - `hybrid`: an xref table with a `/XRefStm` listing the compressed objects
   */
  xref?: 'table' | 'stream' | 'hybrid';
  /** deflates the xref stream */
  compressXref?: boolean;
  /** lists the compressed objects of hybrid files as free in the table, like Word does */
  hybridFreeEntries?: boolean;
  /** objects the xref table lists as freed */
  free?: number[];
  /** objects stored in object streams, listed only by xref streams */
  compressed?: Record<number, CompressedEntry>;
  /** trailer entries besides /Size and /Prev */
  trailer?: string;
};

function bytes(part: string | Buffer): Buffer {
  return typeof part === 'string' ? Buffer.from(part, 'latin1') : part;
}

export function stream(dictEntries: string, data: string | Buffer): Buffer {
  const content = bytes(data);

  return Buffer.concat([
    bytes(`<< ${dictEntries} /Length ${content.length} >>\nstream\n`),
    content,
    bytes('\nendstream'),
  ]);
}

/** An object stream holding the objects in order, with optional trailing padding */
export function objectStream(
  objects: Record<number, string>,
  {
    padding = 0,
    compress = true,
  }: { padding?: number; compress?: boolean } = {},
): Buffer {
  let header = '';
  let body = '';

  for (const [num, content] of Object.entries(objects)) {
    header += `${num} ${body.length} `;
    body += `${content}\n`;
  }

  const decoded = Buffer.concat([
    bytes(`${header}\n${body}`),
    Buffer.alloc(padding, 0x20),
  ]);

  const dict = `/Type /ObjStm /N ${Object.keys(objects).length} /First ${header.length + 1}`;

  return compress ?
      stream(`${dict} /Filter /FlateDecode`, deflateSync(decoded))
    : stream(dict, decoded);
}

export function buildPdf(
  objects: PdfObjects,
  options: SectionOptions = {},
): PdfFile {
  return appendSection(bytes('%PDF-1.7\n'), objects, null, options);
}

/** Appends an incremental update whose trailer points back to `base` */
export function appendUpdate(
  base: PdfFile,
  objects: PdfObjects,
  options: SectionOptions = {},
): PdfFile {
  return appendSection(base.data, objects, base, options);
}

function appendSection(
  prefix: Buffer,
  objects: PdfObjects,
  base: PdfFile | null,
  options: SectionOptions,
): PdfFile {
  const parts: Buffer[] = [prefix];
  let length = prefix.length;
  const offsets = new Map<number, number>();

  function write(part: string | Buffer) {
    const buffer = bytes(part);

    parts.push(buffer);
    length += buffer.length;
  }

  for (const [num, body] of Object.entries(objects)) {
    offsets.set(Number(num), length);
    write(`${num} 0 obj\n`);
    write(body);
    write('\nendobj\n');
  }

  const compressed = new Map(
    Object.entries(options.compressed ?? {}).map(
      ([num, entry]) => [Number(num), entry] as const,
    ),
  );
  const xrefMode = options.xref ?? 'table';
  const usesStream = xrefMode !== 'table';
  const streamNum =
    Math.max(base?.size ?? 1, ...offsets.keys(), ...compressed.keys()) + 1;
  let size = usesStream ? streamNum + 1 : streamNum;
  const trailer = `${options.trailer ?? '/Root 1 0 R'}${base ? ` /Prev ${base.xrefOffset}` : ''}`;
  let xrefStmOffset: number | null = null;

  if (usesStream) {
    const streamOffset = length;
    const rows = new Map<number, number[]>();

    if (xrefMode === 'stream') {
      offsets.set(streamNum, streamOffset);

      for (const [num, offset] of offsets) {
        rows.set(num, [1, ...toBytes(offset, 4), 0, 0]);
      }
    }

    for (const [num, entry] of compressed) {
      rows.set(num, [
        2,
        ...toBytes(entry.objStm, 4),
        ...toBytes(entry.index, 2),
      ]);
    }

    if (!base) rows.set(0, [0, 0, 0, 0, 0, 0xff, 0xff]);

    const sortedNums = [...rows.keys()].sort((a, b) => a - b);
    const rowsData = Buffer.from(
      sortedNums.flatMap((num) => rows.get(num) ?? []),
    );
    const index = groupContiguous(sortedNums).flatMap(({ start, count }) => [
      start,
      count,
    ]);
    const dict = `/Type /XRef /Size ${size} /W [1 4 2] /Index [${index.join(' ')}]${xrefMode === 'stream' ? ` ${trailer}` : ''}`;

    write(`${streamNum} 0 obj\n`);
    write(
      options.compressXref ?
        stream(`${dict} /Filter /FlateDecode`, deflateSync(rowsData))
      : stream(dict, rowsData),
    );
    write('\nendobj\n');

    if (xrefMode === 'stream') {
      write(`startxref\n${streamOffset}\n%%EOF\n`);

      return { data: Buffer.concat(parts), xrefOffset: streamOffset, size };
    }

    xrefStmOffset = streamOffset;
    offsets.set(streamNum, streamOffset);
  } else {
    size = streamNum;
  }

  const xrefOffset = length;
  const sortedNums = [...offsets.keys()].sort((a, b) => a - b);

  if (!base) sortedNums.unshift(0);

  if (options.hybridFreeEntries) sortedNums.push(...compressed.keys());

  sortedNums.push(...(options.free ?? []));
  sortedNums.sort((a, b) => a - b);

  write('xref\n');

  for (const { start, count } of groupContiguous(sortedNums)) {
    write(`${start} ${count}\n`);

    for (let num = start; num < start + count; num++) {
      const offset = offsets.get(num);

      write(
        offset === undefined ?
          `0000000000 ${num === 0 ? '65535' : '00001'} f \n`
        : `${String(offset).padStart(10, '0')} 00000 n \n`,
      );
    }
  }

  write(
    `trailer\n<< /Size ${size} ${trailer}${xrefStmOffset === null ? '' : ` /XRefStm ${xrefStmOffset}`} >>\n`,
  );
  write(`startxref\n${xrefOffset}\n%%EOF\n`);

  return { data: Buffer.concat(parts), xrefOffset, size };
}

function toBytes(value: number, width: number): number[] {
  return Array.from(
    { length: width },
    (_, i) => Math.floor(value / 256 ** (width - 1 - i)) % 256,
  );
}

function groupContiguous(
  sortedNums: number[],
): { start: number; count: number }[] {
  const groups: { start: number; count: number }[] = [];

  for (const num of sortedNums) {
    const last = groups.at(-1);

    if (last && last.start + last.count === num) {
      last.count++;
    } else {
      groups.push({ start: num, count: 1 });
    }
  }

  return groups;
}

/** A catalog (1), a single /Pages node (2) and its pages (3 onwards) */
export function flatPageTree(
  pages: number,
  { count = pages }: { count?: number } = {},
): PdfObjects {
  const objects: PdfObjects = {
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: `<< /Type /Pages /Kids [${pageRefs(3, pages)}] /Count ${count} >>`,
  };

  for (let i = 0; i < pages; i++) objects[3 + i] = page(2);

  return objects;
}

export function page(parent: number): string {
  return `<< /Type /Page /Parent ${parent} 0 R /MediaBox [0 0 612 792] >>`;
}

export function pageRefs(first: number, count: number): string {
  return Array.from({ length: count }, (_, i) => `${first + i} 0 R`).join(' ');
}

export async function createPdfLibPdf(
  pages: number,
  useObjectStreams: boolean,
): Promise<Buffer> {
  const doc = await PDFDocument.create();

  for (let i = 0; i < pages; i++) doc.addPage();

  return Buffer.from(await doc.save({ useObjectStreams }));
}
