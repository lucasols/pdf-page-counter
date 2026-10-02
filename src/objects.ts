import { constants as bufferConstants } from 'node:buffer';
import { constants as zlibConstants, inflateRawSync } from 'node:zlib';
import { rejected, unsupported } from './errors';
import {
  asDict,
  asName,
  asRef,
  getScannedTo,
  getUnsignedInt,
  isWhitespace,
  peekKeyword,
  readKeyword,
  readValue,
  tryReadUnsignedInt,
  type Cursor,
  type PdfDict,
  type PdfRef,
  type PdfValue,
} from './lexer';

/** Work done so far in a call, shared by every read */
export type ReadLimits = {
  inflatedBytes: number;
  maxInflatedBytes: number;
  /** bytes of stream data the parser may walk, filtered or not, which the parse budget is based on */
  decodedBytes: number;
  /** bytes walked by the parser, which only exceed the file and decoded data when objects overlap */
  parsedBytes: number;
  fileBytes: number;
};

/**
 * Charges memory derived from decoded data to `maxInflatedBytes`, before
 * allocating it
 */
export function reserveDecodedBytes(
  limits: ReadLimits,
  bytes: number,
  description: string,
) {
  if (limits.inflatedBytes + bytes > limits.maxInflatedBytes) {
    rejected(
      'too_large',
      `${description} needs ${bytes} bytes, over the ${limits.maxInflatedBytes} bytes limit of decoded data`,
    );
  }

  limits.inflatedBytes += bytes;
}

/**
 * Overlapping objects (several xref entries pointing into one object, or
 * objects nested in each other's strings) would make every read walk the same
 * bytes again. Full parsers repeat the same work, so these files are rejected.
 */
export function countParsedBytes(limits: ReadLimits, bytes: number) {
  limits.parsedBytes += bytes;

  // valid files parse each byte of the file and of the decoded data at most twice, and streams are decoded before they are parsed
  const maxParsedBytes = 2 * (limits.fileBytes + limits.decodedBytes);

  if (limits.parsedBytes > maxParsedBytes) {
    rejected(
      'overlapping_objects',
      `Parsing read more than ${maxParsedBytes} bytes, so objects overlap`,
    );
  }
}

/**
 * Positions a cursor after the `num gen obj` at `offset`. When `expected` is
 * given, a different object at the offset means the xref is broken.
 */
function readObjectHeader(
  data: Buffer,
  offset: number,
  expected: { num: number; gen: number } | null,
): Cursor {
  if (offset >= data.length) {
    unsupported('invalid_object', `Offset ${offset} is past the end of file`);
  }

  const cursor: Cursor = { data, pos: offset };
  const num = tryReadUnsignedInt(cursor);
  const gen = num === null ? null : tryReadUnsignedInt(cursor);

  if (num === null || gen === null || readKeyword(cursor) !== 'obj') {
    unsupported('invalid_object', `No indirect object at offset ${offset}`);
  }

  if (expected && (expected.num !== num || expected.gen !== gen)) {
    unsupported(
      'invalid_object',
      `Expected object ${expected.num} ${expected.gen} at offset ${offset}, found ${num} ${gen}`,
    );
  }

  return cursor;
}

/** Reads the value of the indirect object at `offset`, which can't be a stream */
export function readIndirectObject(
  data: Buffer,
  offset: number,
  expected: { num: number; gen: number },
  limits: ReadLimits,
): PdfValue {
  const cursor = readObjectHeader(data, offset, expected);
  const value = readValue(cursor);
  // the stream data is never decoded, but a stream can't stand in for the dictionaries the reader needs
  const isStream = asDict(value) && peekKeyword(cursor) === 'stream';

  countParsedBytes(limits, getScannedTo(cursor) - offset);

  if (isStream) {
    unsupported(
      'invalid_object',
      `Object ${expected.num} ${expected.gen} is a stream`,
    );
  }

  return value;
}

/**
 * Reads the stream object at `offset`, or returns null when the object isn't a
 * stream. `resolveLength` reads an indirect `/Length`.
 */
export function readStreamObject(
  data: Buffer,
  offset: number,
  expected: { num: number; gen: number } | null,
  limits: ReadLimits,
  resolveLength: ((ref: PdfRef) => number | null) | null,
): { dict: PdfDict; stream: Buffer } | null {
  const cursor = readObjectHeader(data, offset, expected);
  const dict = asDict(readValue(cursor));

  if (!dict || peekKeyword(cursor) !== 'stream') {
    countParsedBytes(limits, getScannedTo(cursor) - offset);
    return null;
  }

  readKeyword(cursor);

  let eolStart = cursor.pos;

  // some writers put spaces before the EOL, which full parsers skip
  while (data[eolStart] === 0x20 || data[eolStart] === 0x09) eolStart++;

  cursor.scannedTo = Math.max(getScannedTo(cursor), eolStart);

  if (data[eolStart] === 0x0d || data[eolStart] === 0x0a) cursor.pos = eolStart;

  // the data starts after the EOL that follows the keyword
  if (data[cursor.pos] === 0x0d) cursor.pos++;
  if (data[cursor.pos] === 0x0a) cursor.pos++;

  const lengthValue = dict.entries.get('Length');
  const lengthRef = asRef(lengthValue);
  const length =
    lengthRef ?
      (resolveLength?.(lengthRef) ?? null)
    : getUnsignedInt(dict, 'Length');
  const { end, scannedTo } = findStreamEnd(data, cursor.pos, length);

  countParsedBytes(limits, Math.max(scannedTo, getScannedTo(cursor)) - offset);

  return { dict, stream: data.subarray(cursor.pos, end) };
}

/** `scannedTo` is the furthest byte read, which the parse budget is charged for */
function findStreamEnd(
  data: Buffer,
  start: number,
  length: number | null,
): { end: number; scannedTo: number } {
  let scannedTo = start;

  if (length !== null && start + length <= data.length) {
    let keywordPos = start + length;

    while (isWhitespace(data[keywordPos])) keywordPos++;

    scannedTo = keywordPos + 'endstream'.length;

    if (data.toString('latin1', keywordPos, scannedTo) === 'endstream') {
      return { end: start + length, scannedTo };
    }
  }

  // without a valid /Length the end keyword delimits the data, which fails if the data contains it
  let end = data.indexOf('endstream', start, 'latin1');

  if (end === -1) unsupported('syntax_error', 'Unterminated stream');

  scannedTo = Math.max(scannedTo, end + 'endstream'.length);

  if (data[end - 1] === 0x0a) end--;
  if (data[end - 1] === 0x0d) end--;

  return { end: Math.max(start, end), scannedTo };
}

export function decodeStream(
  dict: PdfDict,
  stream: Buffer,
  limits: ReadLimits,
): Buffer {
  const filter = dict.entries.get('Filter');
  const filters =
    Array.isArray(filter) ? filter
    : filter === undefined || filter === null ? []
    : [filter];

  if (filters.length === 0) {
    // unfiltered data is skipped as part of the file and then parsed like decoded data, so it counts as both
    limits.decodedBytes += stream.length;
    return stream;
  }

  const filterName = asName(filters[0])?.name;

  if (filters.length !== 1 || filterName !== 'FlateDecode') {
    unsupported(
      'unsupported_filter',
      `Unsupported stream filter ${filterName ?? 'value'}`,
    );
  }

  const inflated = inflate(stream, limits);
  const decodeParmsEntry = dict.entries.get('DecodeParms');
  const decodeParmsValue =
    Array.isArray(decodeParmsEntry) ? decodeParmsEntry[0] : decodeParmsEntry;

  if (decodeParmsValue === undefined || decodeParmsValue === null) {
    return inflated;
  }

  const decodeParms = asDict(decodeParmsValue);

  // skipping parameters the reader can't read, like an indirect dictionary, would decode the data wrong
  if (!decodeParms) {
    unsupported('unsupported_filter', '/DecodeParms is not a dictionary');
  }

  const predictor = decodeParms.entries.get('Predictor') ?? 1;

  if (predictor === 1) return inflated;

  // 10 to 15 are the PNG predictors, which pick the filter of each row in the row itself
  if (typeof predictor !== 'number' || predictor < 10 || predictor > 15) {
    unsupported('unsupported_filter', 'Unsupported predictor');
  }

  const colors = getPredictorParam(decodeParms, 'Colors', 1);
  const bitsPerComponent = getPredictorParam(
    decodeParms,
    'BitsPerComponent',
    8,
  );
  const columns = getPredictorParam(decodeParms, 'Columns', 1);

  if (
    colors < 1 ||
    colors > 32 ||
    ![1, 2, 4, 8, 16].includes(bitsPerComponent) ||
    columns < 1
  ) {
    unsupported('unsupported_filter', 'Invalid PNG predictor parameters');
  }

  const rowLength = Math.ceil((colors * bitsPerComponent * columns) / 8);

  // a row wider than the data can't hold a single row
  if (rowLength + 1 > inflated.length) return Buffer.alloc(0);

  return undoPngPredictor(
    inflated,
    rowLength,
    Math.max(1, Math.ceil((colors * bitsPerComponent) / 8)),
  );
}

/** the default only stands in for a missing entry, since a present but invalid one would decode the data wrong */
function getPredictorParam(
  decodeParms: PdfDict,
  key: string,
  defaultValue: number,
): number {
  if (!decodeParms.entries.has(key)) return defaultValue;

  return (
    getUnsignedInt(decodeParms, key) ??
    unsupported('unsupported_filter', `Invalid /DecodeParms /${key}`)
  );
}

function inflate(stream: Buffer, limits: ReadLimits): Buffer {
  const remaining = limits.maxInflatedBytes - limits.inflatedBytes;

  if (remaining < 1) {
    rejected(
      'too_large',
      `Decoded streams exceed ${limits.maxInflatedBytes} bytes`,
    );
  }

  // full parsers like pdf.js don't verify the Adler-32 checksum, which some writers get wrong, so only the zlib header is checked and the data is inflated raw
  if (stream.length >= 2) {
    const method = stream[0] ?? 0;
    const flags = stream[1] ?? 0;

    if ((method & 0x0f) !== 8 || (method * 256 + flags) % 31 !== 0) {
      unsupported('invalid_stream', 'incorrect header check');
    }

    if (flags & 0x20) {
      unsupported(
        'invalid_stream',
        'FlateDecode data with a preset dictionary',
      );
    }
  }

  let inflated: Buffer;

  try {
    inflated = inflateRawSync(stream.subarray(2), {
      maxOutputLength: Math.min(remaining, bufferConstants.MAX_LENGTH),
      // some writers end the zlib data without a final block, sync flush keeps what was decoded
      finishFlush: zlibConstants.Z_SYNC_FLUSH,
    });
  } catch (error) {
    if (getErrorCode(error) === 'ERR_BUFFER_TOO_LARGE') {
      rejected(
        'too_large',
        `Decoded streams exceed ${limits.maxInflatedBytes} bytes`,
      );
    }

    unsupported(
      'invalid_stream',
      error instanceof Error ? error.message : 'Invalid FlateDecode data',
    );
  }

  limits.inflatedBytes += inflated.length;
  limits.decodedBytes += inflated.length;

  return inflated;
}

function getErrorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ?
      error.code
    : undefined;
}

/**
 * Each row is prefixed by the PNG filter type used to encode it. Rows are
 * decoded in place, which a second buffer would double the memory of: every
 * output byte lands before the input byte it comes from, so no input is
 * overwritten before it is read.
 */
function undoPngPredictor(
  data: Buffer,
  rowLength: number,
  bytesPerPixel: number,
): Buffer {
  const rowsCount = Math.floor(data.length / (rowLength + 1));
  const output = data;

  for (let row = 0; row < rowsCount; row++) {
    const filterType = data[row * (rowLength + 1)];
    const inputStart = row * (rowLength + 1) + 1;
    const outputStart = row * rowLength;

    for (let i = 0; i < rowLength; i++) {
      const raw = data[inputStart + i] ?? 0;
      const left =
        i >= bytesPerPixel ? (output[outputStart + i - bytesPerPixel] ?? 0) : 0;
      const up = row > 0 ? (output[outputStart - rowLength + i] ?? 0) : 0;
      const upLeft =
        row > 0 && i >= bytesPerPixel ?
          (output[outputStart - rowLength + i - bytesPerPixel] ?? 0)
        : 0;

      output[outputStart + i] =
        (raw + getPngPredictorValue(filterType, left, up, upLeft)) & 0xff;
    }
  }

  return output.subarray(0, rowsCount * rowLength);
}

function getPngPredictorValue(
  filterType: number | undefined,
  left: number,
  up: number,
  upLeft: number,
): number {
  switch (filterType) {
    case 0:
      return 0;
    case 1:
      return left;
    case 2:
      return up;
    case 3:
      return Math.floor((left + up) / 2);
    case 4: {
      const estimate = left + up - upLeft;
      const leftDistance = Math.abs(estimate - left);
      const upDistance = Math.abs(estimate - up);
      const upLeftDistance = Math.abs(estimate - upLeft);

      if (leftDistance <= upDistance && leftDistance <= upLeftDistance) {
        return left;
      }

      return upDistance <= upLeftDistance ? up : upLeft;
    }
    default:
      // the row filter types are 0 to 4, so any other byte is corrupt data
      return unsupported('invalid_stream', 'Invalid PNG predictor row');
  }
}
