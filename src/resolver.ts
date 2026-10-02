import { PdfPageCountError, rejected, unsupported } from './errors';
import {
  asDict,
  asRef,
  getName,
  getScannedTo,
  getUnsignedInt,
  readUnsignedInt,
  readValue,
  type Cursor,
  type PdfRef,
  type PdfValue,
} from './lexer';
import {
  countParsedBytes,
  decodeStream,
  reserveDecodedBytes,
  readIndirectObject,
  readStreamObject,
  type ReadLimits,
} from './objects';
import type { Xref } from './xref';

/** a Uint32 object number, a Float64 offset and the Float64 sorted offset */
const BYTES_PER_HEADER_PAIR = 4 + 8 + 8;

export type Resolver = {
  /** undefined when the object is free or missing from the xref */
  resolveRef: (ref: PdfRef) => PdfValue | undefined;
  resolve: (value: PdfValue | undefined) => PdfValue | undefined;
};

type ObjectStream = {
  getObject: (index: number, num: number) => PdfValue;
};

export function createResolver(
  data: Buffer,
  xref: Xref,
  limits: ReadLimits,
): Resolver {
  const isEncrypted = xref.trailers.some((trailer) =>
    trailer.entries.has('Encrypt'),
  );
  const objectStreams = new Map<number, ObjectStream>();

  function getObjectStream(num: number): ObjectStream {
    let objectStream = objectStreams.get(num);

    if (!objectStream) {
      objectStream = readObjectStream(num);
      objectStreams.set(num, objectStream);
    }

    return objectStream;
  }

  /** shared scalars, like a /Type name used by every page, would be parsed again for each node pointing to them */
  const scalars = new Map<
    number,
    { gen: number; value: PdfValue | undefined }
  >();

  function resolveRef(ref: PdfRef): PdfValue | undefined {
    const cached = scalars.get(ref.num);

    if (cached?.gen === ref.gen) return cached.value;

    const value = readRef(ref);

    // dictionaries and non-empty arrays are page tree nodes and /Kids, which are only read once, while empty /Kids can be shared
    if (!asDict(value) && !(Array.isArray(value) && value.length > 0)) {
      scalars.set(ref.num, { gen: ref.gen, value });
    }

    return value;
  }

  function readRef(ref: PdfRef): PdfValue | undefined {
    const entry = xref.getEntry(ref.num);

    if (!entry || entry.type === 'free') return undefined;

    if (entry.type === 'offset') {
      if (entry.gen !== ref.gen) {
        unsupported(
          'invalid_object',
          `Reference ${ref.num} ${ref.gen} R points to generation ${entry.gen}`,
        );
      }

      return readIndirectObject(data, entry.offset, ref, limits);
    }

    if (ref.gen !== 0) {
      unsupported(
        'invalid_object',
        `Compressed object ${ref.num} can't have generation ${ref.gen}`,
      );
    }

    // strings and streams of encrypted files are encrypted, object streams included
    if (isEncrypted) {
      unsupported(
        'encrypted',
        `Object ${ref.num} is in an object stream of an encrypted file`,
      );
    }

    return getObjectStream(entry.objStmNum).getObject(entry.index, ref.num);
  }

  /** the spec keeps the /Length of object streams out of object streams */
  function resolveStreamLength(ref: PdfRef): number | null {
    const entry = xref.getEntry(ref.num);

    if (entry?.type !== 'offset' || entry.gen !== ref.gen) return null;

    const length = resolveRef(ref);

    return (
        typeof length === 'number' &&
          Number.isSafeInteger(length) &&
          length >= 0
      ) ?
        length
      : null;
  }

  function readObjectStream(num: number): ObjectStream {
    const entry = xref.getEntry(num);

    if (entry?.type !== 'offset') {
      unsupported('invalid_object', `Object stream ${num} is not in the file`);
    }

    const object = readStreamObject(
      data,
      entry.offset,
      { num, gen: entry.gen },
      limits,
      resolveStreamLength,
    );

    if (!object || getName(object.dict, 'Type') !== 'ObjStm') {
      unsupported('invalid_object', `Object ${num} is not an object stream`);
    }

    const objectsCount =
      getUnsignedInt(object.dict, 'N') ??
      unsupported('invalid_object', `Invalid object stream ${num} /N`);
    const first =
      getUnsignedInt(object.dict, 'First') ??
      unsupported('invalid_object', `Invalid object stream ${num} /First`);

    const decoded = decodeStream(object.dict, object.stream, limits);

    if (first > decoded.length) {
      unsupported('invalid_object', `Object stream ${num} is truncated`);
    }

    const objectsData = decoded.subarray(first);
    const headerData = decoded.subarray(0, first);

    function readHeader(
      onPair: (index: number, objectNum: number, offset: number) => void,
    ) {
      const header: Cursor = { data: headerData, pos: 0 };

      for (let i = 0; i < objectsCount; i++) {
        const objectNum = readUnsignedInt(header);
        const offset = readUnsignedInt(header);

        if (objectNum > 0xffffffff || offset >= objectsData.length) {
          unsupported('invalid_object', `Invalid object stream ${num} header`);
        }

        onPair(i, objectNum, offset);
      }

      return header.pos;
    }

    // the first pass validates the pairs, so a huge /N fails before anything is allocated for it
    countParsedBytes(
      limits,
      readHeader(() => {}),
    );
    // a header of tiny pairs can still need several times its size in arrays (object numbers, offsets and their sorted copy)
    reserveDecodedBytes(
      limits,
      objectsCount * BYTES_PER_HEADER_PAIR,
      `Object stream ${num} header`,
    );

    const nums = new Uint32Array(objectsCount);
    const offsets = new Float64Array(objectsCount);

    readHeader((index, objectNum, offset) => {
      nums[index] = objectNum;
      offsets[index] = offset;
    });

    const sortedOffsets = offsets.slice().sort();

    // objects sharing data would be parsed again for every object number pointing to them
    for (let i = 1; i < sortedOffsets.length; i++) {
      if (sortedOffsets[i] === sortedOffsets[i - 1]) {
        rejected(
          'overlapping_objects',
          `Object stream ${num} has two objects at offset ${sortedOffsets[i]}`,
        );
      }
    }

    /** `checkOverlap` rejects a value that runs into the next object, which would be read cut or merged with it */
    function readObjectAt(index: number, checkOverlap: boolean): PdfValue {
      const offset = offsets[index] ?? 0;
      const nextOffset = findNextOffset(sortedOffsets, offset);
      // parsing on past the next offset reads the value whole, so a value split across objects (`1` + `0 R`, `1` + `000`) is caught instead of read cut
      const cursor: Cursor = { data: objectsData, pos: offset };

      function rejectOverlap(): never {
        return rejected(
          'overlapping_objects',
          `Object ${nums[index]} of object stream ${num} runs into the object at offset ${nextOffset}`,
        );
      }

      let value: PdfValue;

      try {
        value = readValue(cursor);
      } catch (error) {
        // failed objects are skipped while validating the stream, so their reads count too
        countParsedBytes(limits, getScannedTo(cursor) - offset);

        // a value that needs bytes of the next object, or a window of only whitespace, overlaps it
        if (
          checkOverlap &&
          nextOffset !== undefined &&
          error instanceof PdfPageCountError &&
          error.result.reason === 'syntax_error' &&
          cursor.pos >= nextOffset
        ) {
          rejectOverlap();
        }

        throw error;
      }

      // each object must end where the next one starts
      if (checkOverlap && nextOffset !== undefined && cursor.pos > nextOffset) {
        rejectOverlap();
      }

      countParsedBytes(limits, getScannedTo(cursor) - offset);

      return value;
    }

    // full parsers read every object of an object stream at load, repeating the shared bytes of overlapping objects even if the page tree never uses them
    for (let i = 0; i < objectsCount; i++) {
      try {
        // a single object running into the next one, like a string with an unbalanced parenthesis, is harmless when the page tree doesn't need it, while many overlapping objects exceed the parse budget
        readObjectAt(i, false);
      } catch (error) {
        // objects the page tree doesn't need may be invalid or too large, which is checked again if it reads them, but the parse budget must hold whatever the page tree uses
        if (
          !(error instanceof PdfPageCountError) ||
          error.result.reason === 'overlapping_objects'
        ) {
          throw error;
        }
      }
    }

    return {
      getObject(index, objectNum) {
        if (index >= objectsCount || nums[index] !== objectNum) {
          unsupported(
            'invalid_object',
            `Object ${objectNum} is not at index ${index} of object stream ${num}`,
          );
        }

        return readObjectAt(index, true);
      },
    };
  }

  return {
    resolveRef,
    resolve(value) {
      const ref = asRef(value);

      return ref ? resolveRef(ref) : value;
    },
  };
}

/** the smallest offset greater than `offset` */
function findNextOffset(
  sortedOffsets: Float64Array,
  offset: number,
): number | undefined {
  let low = 0;
  let high = sortedOffsets.length;

  while (low < high) {
    const middle = (low + high) >>> 1;

    if ((sortedOffsets[middle] ?? Infinity) <= offset) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  return sortedOffsets[low];
}
