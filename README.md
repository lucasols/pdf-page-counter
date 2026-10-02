# @ls-stack/pdf-page-counter

Counts the pages of a PDF without parsing the whole document, and holds up against hostile input.

Full parsers such as pdf-lib parse every object and decode the object streams, which can take hundreds of MB for large files and makes a single compression bomb enough to crash the process. This reader follows the cross-reference data from `startxref` and reads only the xref sections, the page tree nodes and the object streams that hold them.

- Synchronous, zero dependencies (`node:zlib`), Node only
- Xref tables, xref streams (FlateDecode + PNG predictors), hybrid files (`/XRefStm`), object streams and incremental updates
- The count comes from walking `/Kids` and must match the root `/Count`, so it can't be inflated by editing `/Count`
- Every decode, parse and walk is bounded

## Installation

```bash
pnpm add @ls-stack/pdf-page-counter
```

## Usage

```ts
import { getPdfPageCount } from '@ls-stack/pdf-page-counter';

const result = getPdfPageCount(pdfBuffer);

switch (result.status) {
  case 'ok':
    return result.pages;
  case 'unsupported':
    // the reader can't handle the file, a full parser may try
    return countWithFullParser(pdfBuffer);
  case 'rejected':
    // hostile or untrustworthy file, a full parser would hit the same problem
    throw new Error(`Invalid PDF: ${result.reason}`);
}
```

`getPdfPageCount` never throws.

### Result

| status        | reason                | meaning                                                                                                                                             |
| ------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ok`          |                       | `pages` is the number of leaves in the page tree, which matches the root `/Count`                                                                   |
| `unsupported` | `invalid_xref`        | missing `startxref`, objects after the last `startxref`, broken xref sections, cyclic `/Prev`, more than `maxXrefSections` sections                 |
|               | `invalid_object`      | an object isn't at its xref offset, `/Root` isn't a `/Catalog`, or a page tree node is missing from the xref or has no `/Type` name                 |
|               | `syntax_error`        | bytes that can't be tokenized as PDF syntax, or a keyword, name or number longer than 64 KiB                                                        |
|               | `unsupported_filter`  | a needed stream uses a filter other than FlateDecode, a predictor other than PNG, or `/DecodeParms` that aren't a direct dictionary of valid values |
|               | `invalid_stream`      | corrupt FlateDecode data or PNG predictor rows                                                                                                      |
|               | `encrypted`           | a needed object is in an object stream of an encrypted file                                                                                         |
|               | `unexpected_error`    | a reader bug, reported instead of thrown                                                                                                            |
| `rejected`    | `too_large`           | decoding or indexing would exceed `maxInflatedBytes`, or a needed object has more than a million values or 100 nesting levels                       |
|               | `too_many_nodes`      | the page tree has more than `maxTreeNodes` nodes                                                                                                    |
|               | `malformed_tree`      | `/Kids` cycles, nodes or `/Kids` arrays reached twice, nodes that aren't dictionaries or are of another type                                        |
|               | `count_mismatch`      | the root `/Count` disagrees with the pages in the tree                                                                                              |
|               | `overlapping_objects` | objects share bytes, so every read would walk them again, in full parsers too                                                                       |

Every failure also has a `detail` message for logs.

Files whose offsets are shifted, for example by junk before `%PDF`, return `unsupported`, since a full parser can usually recover them by scanning the file.

### Options

```ts
getPdfPageCount(data, {
  maxInflatedBytes: 32 * 1024 * 1024, // decoded bytes across all streams in the call, plus the xref and object stream header indexes
  maxTreeNodes: 100_000, // /Pages + /Page nodes
  maxXrefSections: 128, // xref sections followed through /Prev and /XRefStm
});
```

Limits that aren't positive integers (`NaN`, `Infinity`, `0`, negative or fractional values) use the default, so a bad config can't turn a check off.

## Limits

- Decoded stream data counts toward `maxInflatedBytes` and is capped while inflating, so a compression bomb stops at the limit instead of being fully inflated. The arrays built from xref sections and object stream headers count toward it too, before they are allocated.
- Xref entries are looked up per object from compact typed arrays, never materialised into a map, so a huge `/Size` or `/Index` count costs nothing. Empty subsections are dropped, and the arrays for the rest count toward `maxInflatedBytes`. Rows of width zero, negative widths, and `/Index` counts larger than the data are refused.
- A parsed object may hold at most a million values, since a single huge `/Kids` array would otherwise use ~10x its size in memory before any check.
- The page tree is walked iteratively with a visited set, so deep trees can't overflow the stack.
- Objects can't share bytes: object stream entries must have distinct offsets, the ones the page tree reads must end where the next one starts, and the total parsed bytes, including what lookaheads for `num gen R` read before backing off, are capped at twice the file plus decoded data, so objects nested in each other's strings or comments can't make the walk quadratic. Overlaps return `rejected`, since full parsers repeat the same work.
- Page tree nodes must have `/Type /Pages` or `/Type /Page`, like pdf-lib requires. Nodes without a `/Type` name return `unsupported`.
