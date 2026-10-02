import { PdfPageCountError, unsupported } from './errors';
import { asDict, getName } from './lexer';
import type { ReadLimits } from './objects';
import { countPageTreeLeaves } from './pageTree';
import { createResolver } from './resolver';
import { readXref } from './xref';

/**
 * The reader can't handle the file, but nothing suggests it is hostile, so the
 * caller may fall back to a full PDF parser.
 */
export type PdfPageCountUnsupportedReason =
  /** missing `startxref`, objects after the last `startxref`, broken xref sections, cyclic `/Prev` or too many sections */
  | 'invalid_xref'
  /** the object at an xref offset is missing, another object or not the expected type, or a page tree node is not in the xref */
  | 'invalid_object'
  /** the bytes can't be tokenized as PDF syntax, or a keyword, name or number is longer than 64 KiB */
  | 'syntax_error'
  /** a stream the reader needs uses a filter or predictor other than FlateDecode + PNG, or `/DecodeParms` that aren't a direct dictionary of valid values */
  | 'unsupported_filter'
  /** a FlateDecode stream has corrupt data or PNG predictor rows */
  | 'invalid_stream'
  /** a needed object is inside an object stream of an encrypted file */
  | 'encrypted'
  /** a bug in the reader, reported instead of thrown */
  | 'unexpected_error';

/**
 * The file is hostile or its page count can't be trusted. The caller must not
 * fall back to a full parser, which would hit the same problem.
 */
export type PdfPageCountRejectedReason =
  /**
   * the decoded streams would exceed `maxInflatedBytes` (e.g. a compression
   * bomb), or a needed object has more than a million values or is nested
   * deeper than 100 levels
   */
  | 'too_large'
  /** the page tree has more than `maxTreeNodes` nodes */
  | 'too_many_nodes'
  /** the page tree has cycles, shared nodes, or invalid nodes */
  | 'malformed_tree'
  /** the root `/Count` disagrees with the number of pages in the tree */
  | 'count_mismatch'
  /**
   * objects share bytes (object stream entries at the same offset, or objects
   * nested in each other's strings), so every read would walk them again
   */
  | 'overlapping_objects';

export type PdfPageCountResult =
  | { status: 'ok'; pages: number }
  | {
      status: 'unsupported';
      reason: PdfPageCountUnsupportedReason;
      detail: string;
    }
  | { status: 'rejected'; reason: PdfPageCountRejectedReason; detail: string };

/**
 * Limits that aren't positive integers (NaN, Infinity, 0, negative or
 * fractional values) use the default, so a bad config can't turn a check off.
 */
export type GetPdfPageCountOptions = {
  /**
   * Max bytes decoded from FlateDecode streams (xref and object streams) in
   * the whole call, plus the arrays built from xref sections and object stream
   * headers. Going over it rejects the file as `too_large`.
   *
   * @default 33554432 (32 MiB)
   */
  maxInflatedBytes?: number;
  /**
   * Max `/Pages` and `/Page` nodes visited in the page tree. Going over it
   * rejects the file as `too_many_nodes`.
   *
   * @default 100000
   */
  maxTreeNodes?: number;
  /**
   * Max xref sections (tables, streams and the `/XRefStm` of hybrid files)
   * followed through `/Prev`. Going over it returns `unsupported`.
   *
   * @default 128
   */
  maxXrefSections?: number;
};

const DEFAULT_MAX_INFLATED_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_TREE_NODES = 100_000;
const DEFAULT_MAX_XREF_SECTIONS = 128;

/**
 * Counts the pages of a PDF by walking its page tree through the
 * cross-reference data, so only the xref sections, the page tree nodes and
 * the object streams that hold them are read.
 *
 * - `ok`: the number of leaves in the page tree, which matches the root
 *   `/Count`.
 * - `unsupported`: the file uses something this reader doesn't handle, so the
 *   caller may fall back to a full parser.
 * - `rejected`: the file is hostile or its count can't be trusted, so the
 *   caller must not fall back to a full parser.
 *
 * Never throws.
 */
export function getPdfPageCount(
  data: Uint8Array,
  options: GetPdfPageCountOptions = {},
): PdfPageCountResult {
  try {
    // a detached ArrayBuffer makes the conversion throw
    const buffer =
      Buffer.isBuffer(data) ? data : (
        Buffer.from(data.buffer, data.byteOffset, data.byteLength)
      );

    return { status: 'ok', pages: countPages(buffer, options) };
  } catch (error) {
    if (error instanceof PdfPageCountError) return error.result;

    return {
      status: 'unsupported',
      reason: 'unexpected_error',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function countPages(data: Buffer, options: GetPdfPageCountOptions): number {
  const limits: ReadLimits = {
    inflatedBytes: 0,
    maxInflatedBytes: getLimit(
      options.maxInflatedBytes,
      DEFAULT_MAX_INFLATED_BYTES,
    ),
    decodedBytes: 0,
    parsedBytes: 0,
    fileBytes: data.length,
  };
  const xref = readXref(
    data,
    limits,
    getLimit(options.maxXrefSections, DEFAULT_MAX_XREF_SECTIONS),
  );
  // incremental updates may leave /Root out of their trailer
  const rootValue = xref.trailers
    .map((trailer) => trailer.entries.get('Root'))
    .find((root) => root !== undefined);

  if (rootValue === undefined) {
    unsupported('invalid_xref', 'The trailer has no /Root');
  }

  const resolver = createResolver(data, xref, limits);
  const catalog = asDict(resolver.resolve(rootValue));

  // a /Root pointing to another dictionary could hide the real page tree
  if (!catalog || getName(catalog, 'Type') !== 'Catalog') {
    unsupported('invalid_object', 'The /Root is not a /Catalog dictionary');
  }

  const pagesRoot = catalog.entries.get('Pages');

  if (pagesRoot === undefined) {
    unsupported('invalid_object', 'The catalog has no /Pages');
  }

  return countPageTreeLeaves(
    resolver,
    pagesRoot,
    getLimit(options.maxTreeNodes, DEFAULT_MAX_TREE_NODES),
  );
}

/** an invalid limit (NaN, Infinity, 0, negative, fractional) would disable its check, so it falls back to the default */
function getLimit(value: number | undefined, defaultValue: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ?
      value
    : defaultValue;
}
