import { rejected, unsupported } from './errors';

export type PdfRef = { kind: 'ref'; num: number; gen: number };
export type PdfName = { kind: 'name'; name: string };
/** string contents are never needed, so they are skipped */
export type PdfString = { kind: 'string' };

const MAX_NESTING_DEPTH = 100;

/**
 * Values are ~10x larger in memory than in the file, so a single huge array
 * or dictionary could exhaust the memory before anything checks its contents.
 */
const MAX_VALUES_PER_OBJECT = 1_000_000;

const MAX_TOKEN_LENGTH = 64 * 1024;

const WHITESPACE = 1;
const DELIMITER = 2;
const charClass = new Uint8Array(256);

for (const byte of [0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]) {
  charClass[byte] = WHITESPACE;
}

for (const char of '()<>[]{}/%') charClass[char.charCodeAt(0)] = DELIMITER;

export function isWhitespace(byte: number | undefined): boolean {
  return byte !== undefined && charClass[byte] === WHITESPACE;
}

export function isRegular(byte: number | undefined): boolean {
  return byte !== undefined && charClass[byte] === 0;
}

export type Cursor = {
  data: Buffer;
  pos: number;
  /** the furthest position a lookahead read before rewinding, which the parse budget is charged for */
  scannedTo?: number;
};

/** the furthest position read through the cursor, lookaheads included */
export function getScannedTo(cursor: Cursor): number {
  return Math.max(cursor.pos, cursor.scannedTo ?? 0);
}

/** moves the cursor back after a lookahead, keeping what it read for the parse budget */
function rewind(cursor: Cursor, pos: number) {
  cursor.scannedTo = getScannedTo(cursor);
  cursor.pos = pos;
}

export function skipWhitespace(cursor: Cursor) {
  const { data } = cursor;

  while (cursor.pos < data.length) {
    const byte = data[cursor.pos];

    if (byte === 0x25) {
      while (
        cursor.pos < data.length &&
        data[cursor.pos] !== 0x0a &&
        data[cursor.pos] !== 0x0d
      ) {
        cursor.pos++;
      }
    } else if (isWhitespace(byte)) {
      cursor.pos++;
    } else {
      return;
    }
  }
}

function readRegularChars(cursor: Cursor): string {
  const start = cursor.pos;

  while (isRegular(cursor.data[cursor.pos])) {
    cursor.pos++;

    // keywords, names and numbers are short, while a token past the max string length would throw when converted
    if (cursor.pos - start > MAX_TOKEN_LENGTH) {
      unsupported(
        'syntax_error',
        `A token at offset ${start} is longer than ${MAX_TOKEN_LENGTH} bytes`,
      );
    }
  }

  return cursor.data.toString('latin1', start, cursor.pos);
}

export function readKeyword(cursor: Cursor): string {
  skipWhitespace(cursor);

  return readRegularChars(cursor);
}

export function peekKeyword(cursor: Cursor): string {
  const start = cursor.pos;
  const keyword = readKeyword(cursor);

  rewind(cursor, start);

  return keyword;
}

/** Reads the digits at the cursor without allocating, or returns null */
function readDigits(cursor: Cursor): number | null {
  const { data } = cursor;
  const start = cursor.pos;
  let value = 0;
  let byte = data[cursor.pos];

  while (byte !== undefined && byte >= 0x30 && byte <= 0x39) {
    value = value * 10 + byte - 0x30;
    cursor.pos++;
    byte = data[cursor.pos];
  }

  if (
    cursor.pos === start ||
    isRegular(data[cursor.pos]) ||
    !Number.isSafeInteger(value)
  ) {
    return null;
  }

  return value;
}

/** a non-negative safe integer after optional whitespace, or null */
export function tryReadUnsignedInt(cursor: Cursor): number | null {
  skipWhitespace(cursor);

  return readDigits(cursor);
}

export function readUnsignedInt(cursor: Cursor): number {
  skipWhitespace(cursor);

  const start = cursor.pos;
  const value = readDigits(cursor);

  if (value === null) {
    unsupported('syntax_error', `Expected an integer at offset ${start}`);
  }

  return value;
}

/**
 * Parses a PDF number (`12`, `-3.5`, `+.5`, `4.`) in linear time, since a
 * backtracking regex would be quadratic on long digit runs. Returns null for
 * anything else.
 */
function parseNumber(token: string): number | null {
  let i = token.startsWith('+') || token.startsWith('-') ? 1 : 0;
  let digits = 0;
  let hasDot = false;

  for (; i < token.length; i++) {
    const char = token.charCodeAt(i);

    if (char >= 0x30 && char <= 0x39) {
      digits++;
    } else if (char === 0x2e && !hasDot) {
      hasDot = true;
    } else {
      return null;
    }
  }

  return digits > 0 ? Number(token) : null;
}

export type PdfValue =
  | number
  | boolean
  | null
  | PdfRef
  | PdfName
  | PdfString
  | { kind: 'dict'; entries: Map<string, PdfValue> }
  | PdfValue[];

export function readValue(cursor: Cursor): PdfValue {
  return readNestedValue(cursor, 0, { values: 0 });
}

type ParseState = { values: number };

function readNestedValue(
  cursor: Cursor,
  depth: number,
  state: ParseState,
): PdfValue {
  state.values++;

  if (state.values > MAX_VALUES_PER_OBJECT) {
    rejected(
      'too_large',
      `An object has more than ${MAX_VALUES_PER_OBJECT} values`,
    );
  }

  if (depth > MAX_NESTING_DEPTH) {
    // full parsers recurse into the nesting too, and may drop the object when they overflow
    rejected('too_large', `Nesting deeper than ${MAX_NESTING_DEPTH}`);
  }

  skipWhitespace(cursor);

  const { data } = cursor;
  const start = cursor.pos;
  const byte = data[start];

  if (byte === 0x3c && data[start + 1] === 0x3c)
    return readDict(cursor, depth, state);

  if (byte === 0x3c) {
    const end = data.indexOf(0x3e, start);

    if (end === -1) {
      // like the other unterminated values, the cursor stops at the end of the data
      cursor.pos = data.length;
      unsupported('syntax_error', 'Unterminated hex string');
    }

    cursor.pos = end + 1;

    return { kind: 'string' };
  }

  if (byte === 0x28) {
    skipLiteralString(cursor);

    return { kind: 'string' };
  }

  if (byte === 0x5b) {
    cursor.pos++;

    const items: PdfValue[] = [];

    while (true) {
      skipWhitespace(cursor);

      if (cursor.pos >= data.length) {
        unsupported('syntax_error', 'Unterminated array');
      }

      if (data[cursor.pos] === 0x5d) {
        cursor.pos++;
        return items;
      }

      items.push(readNestedValue(cursor, depth + 1, state));
    }
  }

  if (byte === 0x2f) {
    cursor.pos++;

    return { kind: 'name', name: decodeName(readRegularChars(cursor)) };
  }

  const token = readRegularChars(cursor);

  if (token === 'true') return true;
  if (token === 'false') return false;
  if (token === 'null') return null;

  const number = parseNumber(token);

  if (number === null) {
    unsupported(
      'syntax_error',
      token ?
        `Unexpected token "${token.slice(0, 32)}" at offset ${start}`
      : `Unexpected byte at offset ${start}`,
    );
  }

  if (Number.isSafeInteger(number) && number >= 0) {
    const gen = readRefTail(cursor);

    if (gen !== null) return { kind: 'ref', num: number, gen };
  }

  return number;
}

/** `num gen R` is a reference, so after a number look ahead for `gen R` */
function readRefTail(cursor: Cursor): number | null {
  const start = cursor.pos;

  skipWhitespace(cursor);

  const gen = readDigits(cursor);

  if (gen !== null) {
    skipWhitespace(cursor);

    if (
      cursor.data[cursor.pos] === 0x52 &&
      !isRegular(cursor.data[cursor.pos + 1])
    ) {
      cursor.pos++;
      return gen;
    }
  }

  // comments in the lookahead can hide whole objects, so rescanning them for every number would be quadratic
  rewind(cursor, start);

  return null;
}

export type PdfDict = Extract<PdfValue, { kind: 'dict' }>;

function readDict(cursor: Cursor, depth: number, state: ParseState): PdfDict {
  const { data } = cursor;
  const entries = new Map<string, PdfValue>();

  cursor.pos += 2;

  while (true) {
    skipWhitespace(cursor);

    if (cursor.pos >= data.length) {
      unsupported('syntax_error', 'Unterminated dictionary');
    }

    if (data[cursor.pos] === 0x3e && data[cursor.pos + 1] === 0x3e) {
      cursor.pos += 2;
      return { kind: 'dict', entries };
    }

    const key = asName(readNestedValue(cursor, depth + 1, state));

    if (!key) {
      unsupported('syntax_error', `Invalid dictionary key at ${cursor.pos}`);
    }

    const value = readNestedValue(cursor, depth + 1, state);

    // a null value is the same as a missing entry
    if (value === null) {
      entries.delete(key.name);
    } else {
      entries.set(key.name, value);
    }
  }
}

/** names can escape any byte as `#xx` */
function decodeName(raw: string): string {
  if (!raw.includes('#')) return raw;

  return raw.replace(/#([0-9a-fA-F]{2})/g, (_, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
}

/** literal strings may contain balanced or escaped parentheses */
function skipLiteralString(cursor: Cursor) {
  const { data } = cursor;
  let openParens = 0;

  while (cursor.pos < data.length) {
    const byte = data[cursor.pos];

    cursor.pos++;

    if (byte === 0x5c) {
      cursor.pos++;
    } else if (byte === 0x28) {
      openParens++;
    } else if (byte === 0x29) {
      openParens--;

      if (openParens === 0) return;
    }
  }

  unsupported('syntax_error', 'Unterminated literal string');
}

function asObject(
  value: PdfValue | undefined,
): PdfRef | PdfName | PdfString | PdfDict | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }

  return value;
}

export function asRef(value: PdfValue | undefined): PdfRef | null {
  const object = asObject(value);

  return object?.kind === 'ref' ? object : null;
}

export function asName(value: PdfValue | undefined): PdfName | null {
  const object = asObject(value);

  return object?.kind === 'name' ? object : null;
}

export function asDict(value: PdfValue | undefined): PdfDict | null {
  const object = asObject(value);

  return object?.kind === 'dict' ? object : null;
}

/** a non-negative safe integer, or null */
export function getUnsignedInt(dict: PdfDict, key: string): number | null {
  const value = dict.entries.get(key);

  return (
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ) ?
      value
    : null;
}

export function getName(dict: PdfDict, key: string): string | null {
  return asName(dict.entries.get(key))?.name ?? null;
}

/** an array of non-negative safe integers, or null */
export function getUnsignedIntArray(
  value: PdfValue | undefined,
): number[] | null {
  if (!Array.isArray(value)) return null;

  const numbers: number[] = [];

  for (const item of value) {
    if (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 0) {
      return null;
    }

    numbers.push(item);
  }

  return numbers;
}
