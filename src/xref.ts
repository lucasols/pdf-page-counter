import { PdfPageCountError, unsupported } from './errors';
import {
  asDict,
  getName,
  getScannedTo,
  getUnsignedInt,
  getUnsignedIntArray,
  isRegular,
  peekKeyword,
  readKeyword,
  readUnsignedInt,
  readValue,
  skipWhitespace,
  tryReadUnsignedInt,
  type Cursor,
  type PdfDict,
} from './lexer';
import {
  countParsedBytes,
  decodeStream,
  readStreamObject,
  reserveDecodedBytes,
  type ReadLimits,
} from './objects';

export type XrefEntry =
  | { type: 'free' }
  | { type: 'offset'; offset: number; gen: number }
  | { type: 'compressed'; objStmNum: number; index: number };

type SectionLookup = (num: number) => XrefEntry | undefined;

const FREE_ENTRY: XrefEntry = { type: 'free' };

/** the shortest xref table entry is `0 0 n` */
const MIN_TABLE_ENTRY_BYTES = 5;

/** a start, a count, the first entry and the sorted position of a subsection */
const BYTES_PER_SUBSECTION = 8 + 8 + 8 + 4;

/** an offset and a generation */
const BYTES_PER_TABLE_ENTRY = 8 + 4;

/** 8 bytes already hold offsets far past any file size */
const MAX_XREF_STREAM_FIELD_WIDTH = 8;

export type Xref = {
  /** the entry of the newest section that lists the object */
  getEntry: (num: number) => XrefEntry | undefined;
  /** newest first */
  trailers: PdfDict[];
};

/**
 * Reads the xref sections from `startxref` through the `/Prev` chain, keeping
 * only the subsection ranges and the raw entry data, so each object is looked
 * up when needed instead of materialising every entry.
 */
export function readXref(
  data: Buffer,
  limits: ReadLimits,
  maxSections: number,
): Xref {
  const startxrefIndex = data.lastIndexOf('startxref');

  if (startxrefIndex === -1) unsupported('invalid_xref', 'Missing startxref');

  const startxrefEnd = startxrefIndex + 'startxref'.length;

  // an update appended without its own startxref, like a cut download, would be skipped here while full parsers that scan the body read it
  if (
    data.indexOf('obj', startxrefEnd, 'latin1') !== -1 ||
    data.indexOf('xref', startxrefEnd, 'latin1') !== -1 ||
    data.indexOf('trailer', startxrefEnd, 'latin1') !== -1
  ) {
    unsupported(
      'invalid_xref',
      'Objects or xref data after the last startxref',
    );
  }

  const visitedOffsets = new Set<number>();
  const visitedXrefStms = new Set<number>();
  let sectionsCount = 0;

  function countSection() {
    if (sectionsCount >= maxSections) {
      unsupported('invalid_xref', `More than ${maxSections} xref sections`);
    }

    sectionsCount++;
  }

  function visitSection(offset: number) {
    if (visitedOffsets.has(offset)) {
      unsupported('invalid_xref', `The xref chain loops back to ${offset}`);
    }

    countSection();
    visitedOffsets.add(offset);
  }

  /** updates may copy the /XRefStm of the trailer they update, whose entries the newer section already lists */
  function visitXrefStm(offset: number): boolean {
    if (visitedXrefStms.has(offset)) return false;

    countSection();
    visitedXrefStms.add(offset);

    return true;
  }

  const lookups: SectionLookup[] = [];
  const trailers: PdfDict[] = [];
  let offset: number | null =
    tryReadUnsignedInt({ data, pos: startxrefEnd }) ??
    unsupported('invalid_xref', 'Invalid startxref offset');

  // sections are read from the newest update to the oldest
  while (offset !== null) {
    visitSection(offset);

    const section = readSectionAt(data, offset, limits, visitXrefStm);

    lookups.push(section.lookup);
    trailers.push(section.trailer);

    const prev = section.trailer.entries.get('Prev');

    offset =
      prev === undefined || prev === null ?
        null
      : (getUnsignedInt(section.trailer, 'Prev') ??
        unsupported('invalid_xref', 'Invalid /Prev'));
  }

  return {
    trailers,
    getEntry(num) {
      for (const lookup of lookups) {
        const entry = lookup(num);

        if (entry) return entry;
      }

      return undefined;
    },
  };
}

type Section = { lookup: SectionLookup; trailer: PdfDict };

/** a section that can't be parsed, or an offset pointing elsewhere, means the xref is broken */
function readSectionAt(
  data: Buffer,
  offset: number,
  limits: ReadLimits,
  visitXrefStm: (offset: number) => boolean,
): Section {
  try {
    return readSection(data, offset, limits, visitXrefStm);
  } catch (error) {
    if (
      error instanceof PdfPageCountError &&
      (error.result.reason === 'syntax_error' ||
        error.result.reason === 'invalid_object')
    ) {
      unsupported(
        'invalid_xref',
        `Invalid xref section at ${offset}: ${error.result.detail}`,
      );
    }

    throw error;
  }
}

function readSection(
  data: Buffer,
  offset: number,
  limits: ReadLimits,
  visitXrefStm: (offset: number) => boolean,
): Section {
  if (offset >= data.length) {
    unsupported(
      'invalid_xref',
      `Xref offset ${offset} is past the end of file`,
    );
  }

  const cursor: Cursor = { data, pos: offset };

  if (readKeyword(cursor) !== 'xref')
    return readXrefStream(data, offset, limits);

  const table = readXrefTable(cursor, offset, limits);
  const xrefStmOffset = table.trailer.entries.get('XRefStm');

  if (xrefStmOffset === undefined) return table;

  // hybrid files list their compressed objects in an xref stream referenced by the trailer
  const streamOffset =
    getUnsignedInt(table.trailer, 'XRefStm') ??
    unsupported('invalid_xref', 'Invalid /XRefStm');

  if (!visitXrefStm(streamOffset)) return table;

  const stream = readXrefStream(data, streamOffset, limits);

  return {
    trailer: table.trailer,
    lookup(num) {
      const tableEntry = table.lookup(num);

      if (tableEntry && tableEntry.type !== 'free') return tableEntry;

      return stream.lookup(num) ?? tableEntry;
    },
  };
}

function readXrefTable(
  cursor: Cursor,
  sectionOffset: number,
  limits: ReadLimits,
): Section {
  const tableStart = cursor.pos;
  let subsectionsCount = 0;
  let entriesCount = 0;

  // the first pass only counts, so the second can fill typed arrays of the exact size
  scanXrefTable(cursor, {
    onEntry() {
      entriesCount++;
    },
    onSubsection(_start, count) {
      if (count > 0) subsectionsCount++;
    },
  });

  // a few bytes of table text become several times as many bytes of arrays
  reserveDecodedBytes(
    limits,
    subsectionsCount * BYTES_PER_SUBSECTION +
      entriesCount * BYTES_PER_TABLE_ENTRY,
    `Xref table at ${sectionOffset}`,
  );

  const starts = new Float64Array(subsectionsCount);
  const counts = new Float64Array(subsectionsCount);
  /** -1 marks a free entry */
  const offsets = new Float64Array(entriesCount);
  const gens = new Uint32Array(entriesCount);
  let subsection = 0;
  let entry = 0;

  cursor.pos = tableStart;
  scanXrefTable(cursor, {
    onEntry(offset, gen, inUse) {
      offsets[entry] = inUse ? offset : -1;
      gens[entry] = gen;
      entry++;
    },
    onSubsection(start, count) {
      // empty subsections list nothing, so they are dropped
      if (count === 0) return;

      starts[subsection] = start;
      counts[subsection] = count;
      subsection++;
    },
  });

  readKeyword(cursor);

  const trailer = asDict(readValue(cursor));

  if (!trailer) unsupported('invalid_xref', 'Invalid trailer');

  // from the section offset, since sections can share the whitespace before their keyword
  countParsedBytes(limits, getScannedTo(cursor) - sectionOffset);

  const ranges = createRangeIndex(starts, counts);

  return {
    trailer,
    lookup(num) {
      const index = findEntryIndex(ranges, num);

      if (index === -1) return undefined;

      const offset = offsets[index] ?? -1;

      if (offset === -1) return FREE_ENTRY;

      return { type: 'offset', offset, gen: gens[index] ?? 0 };
    },
  };
}

/** Walks the subsections up to the `trailer` keyword */
function scanXrefTable(
  cursor: Cursor,
  handlers: {
    onEntry: (offset: number, gen: number, inUse: boolean) => void;
    /** called after the entries of the subsection */
    onSubsection: (start: number, count: number) => void;
  },
) {
  const { data } = cursor;

  while (peekKeyword(cursor) !== 'trailer') {
    const start = readUnsignedInt(cursor);
    const count = readUnsignedInt(cursor);

    if (count * MIN_TABLE_ENTRY_BYTES > data.length - cursor.pos) {
      unsupported('invalid_xref', `Xref subsection of ${count} is truncated`);
    }

    for (let i = 0; i < count; i++) {
      const offset = readUnsignedInt(cursor);
      const gen = readUnsignedInt(cursor);

      skipWhitespace(cursor);

      const type = data[cursor.pos];

      if (
        (type !== 0x6e && type !== 0x66) || // n or f
        isRegular(data[cursor.pos + 1]) ||
        gen > 0xffffffff
      ) {
        unsupported('invalid_xref', `Invalid xref entry at ${cursor.pos}`);
      }

      cursor.pos++;
      handlers.onEntry(offset, gen, type === 0x6e);
    }

    handlers.onSubsection(start, count);
  }
}

function readXrefStream(
  data: Buffer,
  offset: number,
  limits: ReadLimits,
): Section {
  // the xref isn't known yet, so an indirect /Length can't be resolved
  const object = readStreamObject(data, offset, null, limits, null);

  if (!object || getName(object.dict, 'Type') !== 'XRef') {
    unsupported('invalid_xref', `No xref stream at ${offset}`);
  }

  const { dict, stream } = object;

  const widths = getUnsignedIntArray(dict.entries.get('W'));

  if (
    widths?.length !== 3 ||
    widths.some((width) => width > MAX_XREF_STREAM_FIELD_WIDTH)
  ) {
    unsupported('invalid_xref', 'Invalid xref stream /W');
  }

  const [typeWidth = 0, field2Width = 0, field3Width = 0] = widths;
  const rowWidth = typeWidth + field2Width + field3Width;

  if (rowWidth === 0) unsupported('invalid_xref', 'Xref stream rows are empty');

  const size =
    getUnsignedInt(dict, 'Size') ??
    unsupported('invalid_xref', 'Invalid xref stream /Size');
  const indexValue = dict.entries.get('Index');
  const index =
    indexValue === undefined ? [0, size] : getUnsignedIntArray(indexValue);

  if (!index || index.length % 2 !== 0) {
    unsupported('invalid_xref', 'Invalid xref stream /Index');
  }

  let subsectionsCount = 0;

  for (let i = 1; i < index.length; i += 2) {
    if ((index[i] ?? 0) > 0) subsectionsCount++;
  }

  reserveDecodedBytes(
    limits,
    subsectionsCount * BYTES_PER_SUBSECTION,
    `Xref stream at ${offset} /Index`,
  );

  const starts = new Float64Array(subsectionsCount);
  const counts = new Float64Array(subsectionsCount);
  let subsection = 0;
  let rowsCount = 0;

  for (let i = 0; i < index.length; i += 2) {
    const count = index[i + 1] ?? 0;

    // empty subsections list no rows, so they are dropped
    if (count === 0) continue;

    starts[subsection] = index[i] ?? 0;
    counts[subsection] = count;
    subsection++;
    rowsCount += count;
  }

  const rows = decodeStream(dict, stream, limits);

  if (rowsCount * rowWidth > rows.length) {
    unsupported(
      'invalid_xref',
      `The xref stream lists ${rowsCount} entries but has data for ${Math.floor(rows.length / rowWidth)}`,
    );
  }

  const ranges = createRangeIndex(starts, counts);

  return {
    trailer: dict,
    lookup(num) {
      const row = findEntryIndex(ranges, num);

      if (row === -1) return undefined;

      const rowStart = row * rowWidth;
      // a missing type field means every entry is an in-use object
      const type = typeWidth === 0 ? 1 : readUInt(rows, rowStart, typeWidth);
      const field2 = readUInt(rows, rowStart + typeWidth, field2Width);
      const field3 = readUInt(
        rows,
        rowStart + typeWidth + field2Width,
        field3Width,
      );

      if (type === 1) return { type: 'offset', offset: field2, gen: field3 };

      if (type === 2) {
        return { type: 'compressed', objStmNum: field2, index: field3 };
      }

      // any other type is a reference to the null object
      return FREE_ENTRY;
    },
  };
}

function readUInt(data: Buffer, start: number, width: number): number {
  let value = 0;

  for (let i = 0; i < width; i++) {
    value = value * 256 + (data[start + i] ?? 0);
  }

  return value;
}

/**
 * The non-empty subsections of an xref section in typed arrays, since hostile
 * files can have millions of them. Entries are stored in the subsections' file
 * order.
 */
type RangeIndex = {
  starts: Float64Array;
  counts: Float64Array;
  /** index of the first entry of each subsection */
  firstEntries: Float64Array;
  /** subsections sorted by their first object */
  sorted: Uint32Array;
};

function createRangeIndex(
  starts: Float64Array,
  counts: Float64Array,
): RangeIndex {
  const firstEntries = new Float64Array(starts.length);
  const sorted = new Uint32Array(starts.length);
  let entries = 0;

  for (let i = 0; i < starts.length; i++) {
    firstEntries[i] = entries;
    entries += counts[i] ?? 0;
    sorted[i] = i;
  }

  sorted.sort((a, b) => (starts[a] ?? 0) - (starts[b] ?? 0));

  for (let i = 1; i < sorted.length; i++) {
    const previous = sorted[i - 1] ?? 0;
    const current = sorted[i] ?? 0;

    if (
      (starts[previous] ?? 0) + (counts[previous] ?? 0) >
      (starts[current] ?? 0)
    ) {
      unsupported('invalid_xref', 'Overlapping xref subsections');
    }
  }

  return { starts, counts, firstEntries, sorted };
}

/** the entry index of the object, or -1 when no subsection lists it */
function findEntryIndex(ranges: RangeIndex, num: number): number {
  const { starts, counts, firstEntries, sorted } = ranges;
  let low = 0;
  let high = sorted.length - 1;

  while (low <= high) {
    const middle = (low + high) >>> 1;
    const subsection = sorted[middle] ?? 0;
    const start = starts[subsection] ?? 0;

    if (num < start) {
      high = middle - 1;
    } else if (num >= start + (counts[subsection] ?? 0)) {
      low = middle + 1;
    } else {
      return (firstEntries[subsection] ?? 0) + num - start;
    }
  }

  return -1;
}
