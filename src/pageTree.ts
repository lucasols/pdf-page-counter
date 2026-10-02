import { rejected, unsupported } from './errors';
import { asDict, asName, asRef, type PdfDict, type PdfValue } from './lexer';
import type { Resolver } from './resolver';

type PageTreeNode =
  | { kind: 'page' }
  | { kind: 'pages'; dict: PdfDict; kids: PdfValue[] };

/**
 * Counts the leaves of the page tree and checks the count against the root
 * `/Count`, which is attacker-controlled. Every object may appear only once in
 * the tree, which rules out cycles and pages counted twice.
 */
export function countPageTreeLeaves(
  resolver: Resolver,
  pagesRoot: PdfValue,
  maxTreeNodes: number,
): number {
  const visitedObjects = new Set<number>();

  function visit(value: PdfValue | undefined, description: string) {
    const ref = asRef(value);

    if (!ref) return;

    if (visitedObjects.has(ref.num)) {
      rejected(
        'malformed_tree',
        `${description} (object ${ref.num}) appears more than once in the page tree`,
      );
    }

    visitedObjects.add(ref.num);
  }

  function resolveEntry(
    value: PdfValue | undefined,
    key: string,
  ): PdfValue | undefined {
    const resolved = resolver.resolve(value);
    const ref = asRef(value);

    // like missing nodes, full parsers may find the object in the file body
    if (ref && resolved === undefined) {
      unsupported(
        'invalid_object',
        `The ${key} ${ref.num} ${ref.gen} R of a /Pages node is not in the xref`,
      );
    }

    return resolved;
  }

  function readNode(value: PdfValue | undefined): PageTreeNode {
    visit(value, 'A page tree node');

    const resolved = resolver.resolve(value);
    const ref = asRef(value);
    const description = `Page tree node${ref ? ` ${ref.num} ${ref.gen} R` : ''}`;

    // full parsers rebuild a broken xref from the file body, so they may still find the node
    if (resolved === undefined) {
      unsupported('invalid_object', `${description} is not in the xref`);
    }

    const dict = asDict(resolved);

    if (!dict) rejected('malformed_tree', `${description} is not a dictionary`);

    const type = asName(resolver.resolve(dict.entries.get('Type')))?.name;

    // full parsers skip nodes without a valid /Type, so they decide what these files hold
    if (type === undefined) {
      unsupported('invalid_object', `${description} has no /Type name`);
    }

    if (type === 'Pages') {
      const kidsValue = dict.entries.get('Kids');

      const kids = resolveEntry(kidsValue, '/Kids');

      if (!Array.isArray(kids)) {
        rejected('malformed_tree', 'A /Pages node has no /Kids array');
      }

      // a kids array shared by several nodes would count its pages twice, an empty one counts nothing
      if (kids.length > 0) visit(kidsValue, 'A /Kids array');

      return { kind: 'pages', dict, kids };
    }

    if (type === 'Page') return { kind: 'page' };

    return rejected('malformed_tree', `Invalid page tree node type /${type}`);
  }

  const root = readNode(pagesRoot);

  if (root.kind !== 'pages') {
    rejected('malformed_tree', 'The page tree root is not a /Pages node');
  }

  const declaredCount = resolveEntry(root.dict.entries.get('Count'), '/Count');

  if (
    typeof declaredCount !== 'number' ||
    !Number.isSafeInteger(declaredCount) ||
    declaredCount < 0
  ) {
    rejected('malformed_tree', 'The page tree root has no valid /Count');
  }

  const pending: PdfValue[] = [...root.kids];
  let nodes = 1;
  let pages = 0;

  while (pending.length > 0) {
    // every pending kid is visited unless the walk fails, so the cap can be checked before reading them
    if (nodes + pending.length > maxTreeNodes) {
      rejected(
        'too_many_nodes',
        `The page tree has more than ${maxTreeNodes} nodes`,
      );
    }

    const node = readNode(pending.pop());

    nodes++;

    if (node.kind === 'page') {
      pages++;
    } else {
      for (const kid of node.kids) pending.push(kid);
    }
  }

  if (pages !== declaredCount) {
    rejected(
      'count_mismatch',
      `The page tree has ${pages} pages but its /Count is ${declaredCount}`,
    );
  }

  return pages;
}
